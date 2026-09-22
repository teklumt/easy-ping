import { pgTable, text } from "drizzle-orm/pg-core";
import { createSchema } from "easy-ping/adapters/drizzle";

/**
 * Your users table. easy-ping never owns it — it only stores a user_id
 * string and asks you to resolve the rest via getRecipients.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  locale: text("locale").notNull().default("en"),
});

export const { notification, notificationDelivery, notificationPreference } = createSchema();
