import type {
  ClaimArgs,
  ClaimedDelivery,
  DatabaseAdapter,
  DeliveryRelease,
  FeedPage,
  FeedQuery,
  InsertNotification,
} from "../../core/adapter";
import { decodeBase64Url, encodeBase64Url } from "../../core/base64url";
import { isOperator, type QueryOptions, type WhereClause } from "../../core/store";
import type { Channel, DeliveryRecord, DeliveryStatus, NotificationRecord } from "../../core/types";

type Document = Record<string, unknown>;

/**
 * Minimal structural view of the pieces of the Mongo driver this uses.
 *
 * Typed structurally rather than against the real `Db` so `mongodb` stays an
 * optional peer dependency: an app on Postgres never installs it, and its
 * types are not needed to typecheck this file.
 */
type MongoCollection = {
  insertMany(docs: Document[], options?: unknown): Promise<unknown>;
  insertOne(doc: Document, options?: unknown): Promise<unknown>;
  find(filter: Document, options?: Document): { toArray(): Promise<Document[]> };
  findOne(filter: Document, options?: Document): Promise<Document | null>;
  findOneAndUpdate(
    filter: Document,
    update: Document | Document[],
    options?: Document,
  ): Promise<Document | null>;
  updateOne(
    filter: Document,
    update: Document | Document[],
    options?: Document,
  ): Promise<{
    matchedCount: number;
    modifiedCount: number;
    upsertedCount?: number;
  }>;
  updateMany(
    filter: Document,
    update: Document | Document[],
    options?: Document,
  ): Promise<{
    matchedCount: number;
    modifiedCount: number;
  }>;
  deleteMany(filter: Document, options?: Document): Promise<{ deletedCount: number }>;
  countDocuments(filter: Document, options?: Document): Promise<number>;
  createIndex(spec: Document, options?: Document): Promise<string>;
};

type MongoDb = {
  collection(name: string): MongoCollection;
};

type MongoSession = {
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
  endSession(): Promise<void>;
};

type MongoClient = {
  startSession(): MongoSession;
};

export type MongoAdapterOptions = {
  /** Prefixes every collection name, matching the SQL adapter's table prefix. */
  prefix?: string;
  /**
   * The MongoClient the db came from. Supplying it makes createNotifications
   * atomic; without it a crash between the two writes can leave a notification
   * with no deliveries. Transactions need a replica set, so it is opt-in — a
   * standalone mongod rejects the session outright.
   */
  client?: unknown;
};

const str = (value: unknown): string => String(value);
const nullableStr = (value: unknown): string | null => (value == null ? null : String(value));
const num = (value: unknown): number => Number(value);
const date = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown): Date | null =>
  value == null ? null : value instanceof Date ? value : new Date(String(value));

const encodeCursor = (createdAt: Date, id: string) =>
  encodeBase64Url(`${createdAt.toISOString()}|${id}`);

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const decoded = decodeBase64Url(cursor);
  if (!decoded) return null;

  const [iso, id] = decoded.split("|");
  if (!iso || !id) return null;

  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

/** Documents carry the id as `_id`; the rest of the library never sees that. */
function toNotification(doc: Document): NotificationRecord {
  return {
    id: str(doc._id),
    userId: str(doc.userId),
    type: str(doc.type),
    payload: doc.payload,
    actorId: nullableStr(doc.actorId),
    groupKey: nullableStr(doc.groupKey),
    dedupeKey: nullableStr(doc.dedupeKey),
    seenAt: nullableDate(doc.seenAt),
    readAt: nullableDate(doc.readAt),
    archivedAt: nullableDate(doc.archivedAt),
    createdAt: date(doc.createdAt),
  };
}

function toDelivery(doc: Document): DeliveryRecord {
  return {
    id: str(doc._id),
    notificationId: str(doc.notificationId),
    channel: str(doc.channel) as Channel,
    status: str(doc.status) as DeliveryStatus,
    attempts: num(doc.attempts),
    maxAttempts: num(doc.maxAttempts),
    notBefore: date(doc.notBefore),
    claimedAt: nullableDate(doc.claimedAt),
    claimedBy: nullableStr(doc.claimedBy),
    lastError: nullableStr(doc.lastError),
    updatedAt: date(doc.updatedAt),
  };
}

/** The store hands `id`; documents key on `_id`. */
const toMongoField = (field: string) => (field === "id" ? "_id" : field);

/** Translates a WhereClause into a Mongo filter. */
function toFilter(where: WhereClause): Document {
  const filter: Document = {};

  for (const [field, condition] of Object.entries(where)) {
    const key = toMongoField(field);

    if (condition === null) {
      filter[key] = null;
      continue;
    }

    if (!isOperator(condition)) {
      // The store already refuses these; this is the last line before the
      // driver, where `{ $ne: null }` stops being data and becomes a query.
      if (typeof condition === "object" && !(condition instanceof Date)) {
        throw new Error(`mongo filter on "${field}" received an object; only scalars are bound`);
      }
      filter[key] = condition;
      continue;
    }

    const operator = condition as Record<string, unknown>;
    if ("in" in operator) filter[key] = { $in: operator.in };
    else if ("lt" in operator) filter[key] = { $lt: operator.lt };
    else if ("lte" in operator) filter[key] = { $lte: operator.lte };
    else if ("gt" in operator) filter[key] = { $gt: operator.gt };
    else if ("gte" in operator) filter[key] = { $gte: operator.gte };
    else if ("not" in operator) {
      // $ne null also matches a missing field, which is what "not null" means.
      filter[key] = { $ne: operator.not };
    }
  }

  return filter;
}

/** A duplicate on a unique index, rather than a real write failure. */
const isDuplicateKey = (error: unknown): boolean => {
  const code = (error as { code?: number; writeErrors?: { code?: number }[] })?.code;
  if (code === 11000) return true;
  const writeErrors = (error as { writeErrors?: { code?: number }[] })?.writeErrors;
  return Array.isArray(writeErrors) && writeErrors.some((entry) => entry?.code === 11000);
};

export function mongoAdapter(db: unknown, options: MongoAdapterOptions = {}): DatabaseAdapter {
  const database = db as MongoDb;
  const prefix = options.prefix ?? "";

  const client = options.client as MongoClient | undefined;

  const notifications = () => database.collection(`${prefix}notification`);
  const deliveries = () => database.collection(`${prefix}notification_delivery`);

  /**
   * Runs `fn` in a transaction when a client was supplied, and plainly
   * otherwise. The session must reach every command inside, so `fn` receives
   * it — a write that omits it silently runs outside the transaction.
   *
   * One transaction per notification, not per batch: a duplicate key aborts
   * the transaction it happens in, and dedupe is the expected path here, so a
   * batch-wide transaction would throw away the notifications around it.
   */
  async function atomically<T>(fn: (session?: MongoSession) => Promise<T>): Promise<T> {
    if (!client) return fn();

    const session = client.startSession();
    try {
      return await session.withTransaction(() => fn(session));
    } finally {
      await session.endSession();
    }
  }

  return {
    name: "mongodb",
    // Documents keep the declared camelCase, and store objects natively.
    naming: "preserve",
    serializesJson: false,

    async createNotifications(input: readonly InsertNotification[]) {
      if (input.length === 0) return { created: [], deduped: [] };

      const created: string[] = [];
      const deduped: string[] = [];

      for (const row of input) {
        const now = new Date();

        try {
          await atomically(async (session) => {
            const options = session ? { session } : undefined;

            // The notification goes in first: it carries the unique dedupe
            // index, so a duplicate is rejected before any delivery is written.
            await notifications().insertOne(
              {
                _id: row.id,
                userId: row.userId,
                type: row.type,
                payload: row.payload ?? null,
                actorId: row.actorId ?? null,
                groupKey: row.groupKey ?? null,
                dedupeKey: row.dedupeKey ?? null,
                seenAt: null,
                readAt: null,
                archivedAt: null,
                createdAt: now,
              },
              options,
            );

            if (row.deliveries.length > 0) {
              await deliveries().insertMany(
                row.deliveries.map((delivery) => ({
                  _id: delivery.id,
                  notificationId: row.id,
                  channel: delivery.channel,
                  status: "pending",
                  attempts: 0,
                  maxAttempts: delivery.maxAttempts,
                  notBefore: delivery.notBefore,
                  claimedAt: null,
                  claimedBy: null,
                  lastError: null,
                  updatedAt: now,
                })),
                options,
              );
            }
          });

          created.push(row.id);
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          deduped.push(row.id);
        }
      }

      return { created, deduped };
    },

    async claimPendingDeliveries(args: ClaimArgs): Promise<readonly ClaimedDelivery[]> {
      const now = args.now ?? new Date();
      const staleBefore = new Date(now.getTime() - args.leaseMs);

      const eligible: Document = {
        $and: [
          {
            $or: [{ status: "pending" }, { status: "claimed", claimedAt: { $lt: staleBefore } }],
          },
          { notBefore: { $lte: now } },
          { $expr: { $lt: ["$attempts", "$maxAttempts"] } },
        ],
      };

      if (args.channels && args.channels.length > 0) {
        (eligible.$and as Document[]).push({ channel: { $in: [...args.channels] } });
      }
      if (args.ids && args.ids.length > 0) {
        (eligible.$and as Document[]).push({ _id: { $in: [...args.ids] } });
      }

      // findOneAndUpdate is atomic per document, so two concurrent callers
      // cannot be handed the same delivery. updateMany would be one round trip
      // but gives no way to learn which documents this call actually won.
      const claimed: Document[] = [];
      for (let taken = 0; taken < args.limit; taken += 1) {
        const doc = await deliveries().findOneAndUpdate(
          eligible,
          { $set: { status: "claimed", claimedAt: now, claimedBy: args.claimToken } },
          { sort: { notBefore: 1, _id: 1 }, returnDocument: "after" },
        );
        if (!doc) break;
        claimed.push(doc);
      }

      if (claimed.length === 0) return [];

      // One lookup for the batch rather than one per delivery.
      const parents = await notifications()
        .find({ _id: { $in: claimed.map((doc) => doc.notificationId) } })
        .toArray();
      const byId = new Map(parents.map((doc) => [str(doc._id), doc]));

      return claimed.flatMap((doc) => {
        const parent = byId.get(str(doc.notificationId));
        if (!parent) return [];

        return [
          {
            id: str(doc._id),
            notificationId: str(doc.notificationId),
            channel: str(doc.channel) as Channel,
            attempts: num(doc.attempts),
            maxAttempts: num(doc.maxAttempts),
            notification: {
              userId: str(parent.userId),
              type: str(parent.type),
              payload: parent.payload,
              actorId: nullableStr(parent.actorId),
            },
          },
        ];
      });
    },

    async releaseDeliveries(releases: readonly DeliveryRelease[]) {
      if (releases.length === 0) return;
      const now = new Date();

      for (const { id, outcome, nextAttemptAt } of releases) {
        const failed = outcome.result === "failed";
        const skipped = outcome.result === "skipped";
        const retryable = failed && outcome.retryable;

        // An aggregation-pipeline update so the terminal-vs-retry decision
        // reads maxAttempts from the document itself, as the SQL CASE does.
        await deliveries().updateOne({ _id: id }, [
          {
            $set: {
              attempts: failed ? { $add: ["$attempts", 1] } : "$attempts",
              status: failed
                ? {
                    $cond: [
                      { $and: [retryable, { $lt: [{ $add: ["$attempts", 1] }, "$maxAttempts"] }] },
                      "pending",
                      "failed",
                    ],
                  }
                : skipped
                  ? "skipped"
                  : "sent",
              // $literal: an error message starting with "$" would otherwise
              // be read as a field path.
              lastError: failed
                ? { $literal: outcome.error.slice(0, 2000) }
                : skipped
                  ? { $literal: outcome.reason.slice(0, 2000) }
                  : null,
              notBefore: nextAttemptAt ?? "$notBefore",
              // Written unconditionally: if the lease expired and another
              // worker re-sent, the duplicate already happened and the true
              // terminal state beats leaving the row wedged in "claimed".
              claimedAt: null,
              claimedBy: null,
              updatedAt: now,
            },
          },
        ]);
      }
    },

    async listNotifications(query: FeedQuery): Promise<FeedPage> {
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;

      const filter: Document = { userId: query.userId, archivedAt: null };
      if (query.unreadOnly) filter.readAt = null;

      if (cursor) {
        // Matches the SQL row comparison (createdAt, id) < (cursor, cursorId).
        filter.$or = [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
        ];
      }

      const docs = await notifications()
        .find(filter, { sort: { createdAt: -1, _id: -1 }, limit: query.limit + 1 })
        .toArray();

      const page = docs.slice(0, query.limit).map(toNotification);
      const last = page.at(-1);

      return {
        notifications: page,
        nextCursor:
          docs.length > query.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      };
    },

    async countUnseen(userId: string) {
      return notifications().countDocuments({ userId, seenAt: null, archivedAt: null });
    },

    async markSeen(userId: string, before: Date) {
      await notifications().updateMany(
        { userId, seenAt: null, createdAt: { $lte: before } },
        { $set: { seenAt: new Date() } },
      );
    },

    async markRead(userId: string, notificationIds: readonly string[]) {
      if (notificationIds.length === 0) return 0;

      // Scoped by userId as well as id, and idempotent: re-marking a read
      // notification reports success rather than a 404.
      const filter = { userId, _id: { $in: [...notificationIds] } };
      await notifications().updateMany(
        { ...filter, readAt: null },
        {
          $set: { readAt: new Date() },
        },
      );

      return notifications().countDocuments(filter);
    },

    async markAllRead(userId: string) {
      const result = await notifications().updateMany(
        { userId, readAt: null },
        { $set: { readAt: new Date() } },
      );
      return result.modifiedCount;
    },

    async getFailedDeliveries(args: { since: Date; limit: number }) {
      const docs = await deliveries()
        .find(
          { status: "failed", updatedAt: { $gte: args.since } },
          { sort: { updatedAt: -1 }, limit: args.limit },
        )
        .toArray();

      return docs.map(toDelivery);
    },

    async queryTable(table: string, where: WhereClause, options: QueryOptions) {
      const find: Document = {};
      if (options.limit) find.limit = options.limit;
      if (options.orderBy) {
        const direction = options.orderBy.direction === "desc" ? -1 : 1;
        find.sort = { [toMongoField(options.orderBy.field)]: direction };
      }

      const docs = await database.collection(table).find(toFilter(where), find).toArray();

      // `_id` is a storage detail; plugins declared the field as `id`.
      return docs.map(({ _id, ...rest }) => (_id === undefined ? rest : { id: _id, ...rest }));
    },

    async insertRows(
      table: string,
      rows: readonly Record<string, unknown>[],
      onConflict?: readonly string[],
    ) {
      if (rows.length === 0) return 0;

      const documents = rows.map(({ id, ...rest }) =>
        id === undefined ? { ...rest } : { _id: id, ...rest },
      );

      if (!onConflict || onConflict.length === 0) {
        await database.collection(table).insertMany(documents as Document[]);
        return documents.length;
      }

      // Upsert keyed on the conflict fields, matching ON CONFLICT DO UPDATE.
      let written = 0;
      for (const document of documents as Document[]) {
        const key: Document = {};
        for (const field of onConflict) key[toMongoField(field)] = document[toMongoField(field)];

        // _id goes in $setOnInsert, never $set: Mongo rejects an update that
        // would modify it, so a conflicting upsert must leave it alone.
        const { _id, ...updatable } = document;
        const update: Document = { $set: updatable };
        if (_id !== undefined) update.$setOnInsert = { _id };

        const result = await database.collection(table).updateOne(key, update, { upsert: true });
        written += result.matchedCount + (result.upsertedCount ?? 0);
      }
      return written;
    },

    async updateRows(table: string, where: WhereClause, set: Record<string, unknown>) {
      const assignments: Document = {};
      for (const [field, value] of Object.entries(set)) assignments[toMongoField(field)] = value;
      if (Object.keys(assignments).length === 0) return 0;

      const result = await database
        .collection(table)
        .updateMany(toFilter(where), { $set: assignments });
      return result.matchedCount;
    },

    async deleteRows(table: string, where: WhereClause) {
      const result = await database.collection(table).deleteMany(toFilter(where));
      return result.deletedCount;
    },
  };
}
