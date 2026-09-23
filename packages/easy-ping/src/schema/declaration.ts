import type { SchemaDeclaration } from "../core/plugin";

export const toSnakeCase = (value: string) => value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Core tables in the plugin format. A drift test asserts it agrees with the Drizzle schema. */
export const coreSchema = {
  notification: {
    tableName: "notification",
    fields: {
      id: { type: "string", required: true },
      userId: { type: "string", required: true },
      type: { type: "string", required: true },
      payload: { type: "json", required: true },
      actorId: { type: "string" },
      groupKey: { type: "string" },
      dedupeKey: { type: "string" },
      seenAt: { type: "date" },
      readAt: { type: "date" },
      archivedAt: { type: "date" },
      createdAt: { type: "date", required: true, defaultNow: true },
    },
    primaryKey: ["id"],
    indexes: [
      { on: ["userId", "createdAt"], name: "notification_feed_idx" },
      { on: ["userId", "groupKey"], name: "notification_group_idx" },
      { on: ["userId", "dedupeKey"], unique: true, name: "notification_dedupe_idx" },
    ],
  },

  notificationDelivery: {
    tableName: "notification_delivery",
    fields: {
      id: { type: "string", required: true },
      notificationId: { type: "string", required: true },
      channel: { type: "string", required: true },
      status: { type: "string", required: true, default: "pending" },
      attempts: { type: "number", required: true, default: 0 },
      maxAttempts: { type: "number", required: true, default: 5 },
      notBefore: { type: "date", required: true, defaultNow: true },
      claimedAt: { type: "date" },
      claimedBy: { type: "string" },
      lastError: { type: "string" },
      updatedAt: { type: "date", required: true, defaultNow: true },
    },
    primaryKey: ["id"],
    indexes: [
      { on: ["status", "notBefore"], name: "delivery_claim_idx" },
      { on: ["notificationId"], name: "delivery_notification_idx" },
    ],
  },

  notificationPreference: {
    tableName: "notification_preference",
    fields: {
      userId: { type: "string", required: true },
      type: { type: "string", required: true },
      channel: { type: "string", required: true },
      enabled: { type: "boolean", required: true, default: true },
      frequency: { type: "string", required: true, default: "instant" },
      updatedAt: { type: "date", required: true, defaultNow: true },
    },
    primaryKey: ["userId", "type", "channel"],
  },
} satisfies SchemaDeclaration;
