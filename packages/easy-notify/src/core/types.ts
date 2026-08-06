export type Channel = "inApp" | "email" | "push" | "sms" | "slack";

export type DeliveryStatus = "pending" | "claimed" | "sent" | "failed" | "skipped";

export type DeliveryMode = "inline" | "deferred" | "worker" | "cron";

export type Frequency = "instant" | "daily" | "weekly" | "off";

export type SkipReason = "deduped" | "no-channels" | "no-recipient";

export type Recipient = {
  userId: string;
  email?: string | undefined;
  phone?: string | undefined;
  pushTokens?: readonly string[] | undefined;
  timezone: string;
  locale: string;
};

export type NotificationRecord = {
  id: string;
  userId: string;
  type: string;
  payload: unknown;
  actorId: string | null;
  groupKey: string | null;
  dedupeKey: string | null;
  seenAt: Date | null;
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
};

export type DeliveryRecord = {
  id: string;
  notificationId: string;
  channel: Channel;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  notBefore: Date;
  claimedAt: Date | null;
  claimedBy: string | null;
  lastError: string | null;
  updatedAt: Date;
};
