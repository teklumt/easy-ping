import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Channel, DeliveryStatus, Frequency } from "../../core/types";

export function createSchema(prefix = "") {
  const name = (base: string) => `${prefix}${base}`;

  const notification = pgTable(
    name("notification"),
    {
      id: text("id").primaryKey(),
      userId: text("user_id").notNull(),
      type: text("type").notNull(),
      payload: jsonb("payload").notNull(),
      actorId: text("actor_id"),
      groupKey: text("group_key"),
      dedupeKey: text("dedupe_key"),
      seenAt: timestamp("seen_at", { withTimezone: true }),
      readAt: timestamp("read_at", { withTimezone: true }),
      archivedAt: timestamp("archived_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index(name("notification_feed_idx")).on(table.userId, table.createdAt.desc()),
      index(name("notification_unseen_idx")).on(table.userId).where(sql`${table.seenAt} is null`),
      index(name("notification_group_idx")).on(table.userId, table.groupKey),
      // Postgres treats NULLs as distinct here, so unlimited rows may carry no
      // dedupe key while a present one is enforced unique per user.
      uniqueIndex(name("notification_dedupe_idx")).on(table.userId, table.dedupeKey),
    ],
  );

  const notificationDelivery = pgTable(
    name("notification_delivery"),
    {
      id: text("id").primaryKey(),
      notificationId: text("notification_id")
        .notNull()
        .references(() => notification.id, { onDelete: "cascade" }),
      channel: text("channel").$type<Channel>().notNull(),
      status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
      attempts: integer("attempts").notNull().default(0),
      maxAttempts: integer("max_attempts").notNull().default(5),
      notBefore: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
      claimedAt: timestamp("claimed_at", { withTimezone: true }),
      claimedBy: text("claimed_by"),
      lastError: text("last_error"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
      index(name("delivery_claim_idx")).on(table.status, table.notBefore),
      index(name("delivery_notification_idx")).on(table.notificationId),
    ],
  );

  const notificationPreference = pgTable(
    name("notification_preference"),
    {
      userId: text("user_id").notNull(),
      type: text("type").notNull(),
      channel: text("channel").$type<Channel>().notNull(),
      enabled: boolean("enabled").notNull().default(true),
      frequency: text("frequency").$type<Frequency>().notNull().default("instant"),
    },
    (table) => [primaryKey({ columns: [table.userId, table.type, table.channel] })],
  );

  return { notification, notificationDelivery, notificationPreference };
}

export type EasyPingSchema = ReturnType<typeof createSchema>;

export const schema = createSchema();
