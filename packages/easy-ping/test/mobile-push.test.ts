import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { EasyPingConfig } from "../src/core/config";
import type { NotificationDefinitions } from "../src/core/definition";
import { easyPing } from "../src/core/instance";
import type { Recipient } from "../src/core/types";
import { mobilePush, mobilePushSchema } from "../src/plugins/mobile-push";
import type {
  MobilePushMessage,
  MobilePushProvider,
  MobilePushReceipt,
  MobilePushTicket,
} from "../src/providers/expo-push";
import { availableBackends, type Backend } from "./helpers/backends";

const BASE = "/api/notifications";
const CRON = "cron-secret-0123456789";
const T = (n: number) => `ExponentPushToken[${String(n).padStart(22, "x")}]`;

const definitions = {
  ping: { channels: ["mobilePush"] },
  both: { channels: ["inApp", "mobilePush"] },
} satisfies NotificationDefinitions;

const recipient = (userId: string): Recipient => ({
  userId,
  email: `${userId}@x.dev`,
  timezone: "UTC",
  locale: "en",
});

const sqlite = availableBackends.find((backend) => backend.name === "sqlite");
if (!sqlite) throw new Error("sqlite backend missing");

let db: Backend;
let outbox: MobilePushMessage[][] = [];
let behaviour: (message: MobilePushMessage) => MobilePushTicket = () => ({
  ok: true,
  ticketId: null,
});
let receiptQueue: MobilePushReceipt[] = [];
let receiptRequests: string[][] = [];

const provider: MobilePushProvider = {
  name: "fake-expo",
  isValidToken: (token) => token.startsWith("ExponentPushToken["),
  send: async (messages) => {
    outbox.push([...messages]);
    return messages.map(behaviour);
  },
  receipts: async (ids) => {
    receiptRequests.push([...ids]);
    return receiptQueue;
  },
};

function build(
  pluginOverrides: Partial<Parameters<typeof mobilePush>[0]> = {},
  overrides: Partial<EasyPingConfig<typeof definitions>> = {},
) {
  const plugin = mobilePush({
    provider,
    maxDevicesPerUser: 2,
    render: ({ type, payload }) => ({
      title: "New",
      body: `${type}: ${(payload as { who?: string }).who ?? "someone"}`,
      data: { extra: 1 },
    }),
    ...pluginOverrides,
  });
  const notify = easyPing({
    database: db.adapter,
    secret: "test-signing-secret-0123456789",
    cron: { secret: CRON },
    session: { getUserId: async (request) => request.headers.get("x-user") },
    getRecipients: async (ids) => ids.map(recipient),
    notifications: definitions,
    channels: { inApp: { enabled: true } },
    delivery: { mode: "cron" },
    logger: { warn: () => {}, error: () => {} },
    plugins: [plugin],
    ...overrides,
  });
  return { notify, plugin };
}

const post = (path: string, body: unknown, userId = "u1") =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-user": userId },
    body: JSON.stringify(body),
  });
const machine = (path: string) =>
  new Request(`https://app.dev${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON}` },
  });
const runCron = (notify: ReturnType<typeof build>["notify"]) =>
  notify.handler.POST(machine("/cron"));

const register = (
  built: ReturnType<typeof build>,
  token: string,
  userId = "u1",
  platform = "ios",
) => built.notify.handler.POST(post("/mobile-push/devices", { token, platform }, userId));

const devices = () => db.rows("notification_mobile_push_device");
const tickets = () => db.rows("notification_mobile_push_ticket");

describe("mobilePush plugin", () => {
  beforeAll(async () => {
    db = await sqlite.create("mobile-push");
    await db.applySchema(mobilePushSchema);
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await db.truncate();
    outbox = [];
    receiptQueue = [];
    receiptRequests = [];
    behaviour = () => ({ ok: true, ticketId: null });
  });

  describe("registration", () => {
    it("stores a valid token once and refreshes it on re-registration", async () => {
      const built = build();
      expect((await register(built, T(1))).status).toBe(200);
      const again = await built.notify.handler.POST(
        post("/mobile-push/devices", { token: T(1), platform: "android", deviceName: "Pixel" }),
      );
      expect(again.status).toBe(200);
      const rows = await devices();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ user_id: "u1", platform: "android", device_name: "Pixel" });
    });

    it("rejects malformed tokens and unknown platforms", async () => {
      const built = build();
      expect((await register(built, "not-a-token")).status).toBe(400);
      expect((await register(built, T(1), "u1", "watch")).status).toBe(400);
      expect(await devices()).toHaveLength(0);
    });

    it("refuses to re-home a token another account registered", async () => {
      const built = build();
      await register(built, T(1), "u1");
      const stolen = await register(built, T(1), "u2");
      expect(stolen.status).toBe(409);
      expect((await devices())[0]?.user_id).toBe("u1");
    });

    it("evicts the least recently seen device past the cap", async () => {
      const built = build();
      await register(built, T(1));
      await register(built, T(2));
      await register(built, T(3));
      const rows = await devices();
      expect(rows.map((row) => row.token).sort()).toEqual([T(2), T(3)]);
    });

    it("lists a user's devices without exposing tokens, and removes by token", async () => {
      const built = build();
      await register(built, T(1));
      await register(built, T(2), "u2");
      const listed = await built.notify.handler.GET(
        new Request(`https://app.dev${BASE}/mobile-push/devices`, { headers: { "x-user": "u1" } }),
      );
      const body = (await listed.json()) as { devices: { tokenSuffix: string }[] };
      expect(body.devices).toHaveLength(1);
      expect(JSON.stringify(body)).not.toContain(T(1));
      expect(body.devices[0]?.tokenSuffix).toBe(T(1).slice(-6));

      // u1 cannot remove u2's device by token.
      const foreign = await built.notify.handler.POST(
        post("/mobile-push/devices/remove", { token: T(2) }, "u1"),
      );
      expect(foreign.status).toBe(404);
      const own = await built.notify.handler.POST(
        post("/mobile-push/devices/remove", { token: T(1) }, "u1"),
      );
      expect(own.status).toBe(200);
      expect(await devices()).toHaveLength(1);
    });
  });

  describe("delivery", () => {
    it("fans out one batch to every device with the notification id in data", async () => {
      const built = build();
      await register(built, T(1));
      await register(built, T(2));
      behaviour = () => ({ ok: true, ticketId: `tk-${Math.random()}` });

      const { notifications } = await built.notify.send("ping", {
        to: "u1",
        payload: { who: "Dana" },
      });
      await runCron(built.notify);

      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.map((m) => m.token).sort()).toEqual([T(1), T(2)]);
      expect(outbox[0]?.[0]).toMatchObject({
        title: "New",
        body: "ping: Dana",
        data: { extra: 1, notificationId: notifications[0]?.id, type: "ping" },
      });
      const deliveries = await db.rows("notification_delivery");
      expect(deliveries[0]?.status).toBe("sent");
      expect(await tickets()).toHaveLength(2);
    });

    it("skips, not fails, a user with no device", async () => {
      const built = build();
      await built.notify.send("both", { to: "u9", payload: {} });
      await runCron(built.notify);
      const rows = await db.rows("notification_delivery");
      expect(Object.fromEntries(rows.map((row) => [row.channel, row.status]))).toEqual({
        inApp: "sent",
        mobilePush: "skipped",
      });
    });

    it("prunes a token the service reports gone and fails without retry when none remain", async () => {
      const built = build();
      await register(built, T(1));
      behaviour = () => ({ ok: false, error: "DeviceNotRegistered", gone: true, retryable: false });
      await built.notify.send("ping", { to: "u1", payload: {} });
      await runCron(built.notify);
      expect(await devices()).toHaveLength(0);
      const [delivery] = await db.rows("notification_delivery");
      expect(delivery).toMatchObject({ status: "failed", attempts: 1 });
    });

    it("keeps a rate-limited delivery pending for another attempt", async () => {
      const built = build();
      await register(built, T(1));
      behaviour = () => ({ ok: false, error: "MessageRateExceeded", gone: false, retryable: true });
      await built.notify.send("ping", { to: "u1", payload: {} });
      await runCron(built.notify);
      const [delivery] = await db.rows("notification_delivery");
      expect(delivery).toMatchObject({ status: "pending", attempts: 1 });
      expect(await devices()).toHaveLength(1);
    });

    it("counts a send as delivered when any device accepted", async () => {
      const built = build();
      await register(built, T(1));
      await register(built, T(2));
      behaviour = (message) =>
        message.token === T(1)
          ? { ok: false, error: "DeviceNotRegistered", gone: true, retryable: false }
          : { ok: true, ticketId: "tk" };
      await built.notify.send("ping", { to: "u1", payload: {} });
      await runCron(built.notify);
      expect((await db.rows("notification_delivery"))[0]?.status).toBe("sent");
      expect((await devices()).map((row) => row.token)).toEqual([T(2)]);
    });
  });

  describe("receipts", () => {
    it("asks the provider about accepted tickets and prunes devices it reports gone", async () => {
      const built = build();
      await register(built, T(1));
      await register(built, T(2));
      behaviour = (message) => ({ ok: true, ticketId: `tk-${message.token.slice(-3)}` });
      await built.notify.send("ping", { to: "u1", payload: {} });
      await runCron(built.notify);
      expect(await tickets()).toHaveLength(2);

      receiptQueue = [
        { ticketId: `tk-${T(1).slice(-3)}`, ok: true },
        { ticketId: `tk-${T(2).slice(-3)}`, ok: false, error: "DeviceNotRegistered", gone: true },
      ];
      const response = await built.notify.handler.POST(machine("/mobile-push/receipts"));
      expect(await response.json()).toEqual({ checked: 2, pruned: 1 });
      expect(receiptRequests[0]?.length).toBe(2);
      expect((await devices()).map((row) => row.token)).toEqual([T(1)]);
      expect(await tickets()).toHaveLength(0);
    });

    it("is a no-op with nothing pending, and needs the machine secret", async () => {
      const built = build();
      const response = await built.notify.handler.POST(machine("/mobile-push/receipts"));
      expect(await response.json()).toEqual({ checked: 0, pruned: 0 });
      const anonymous = await built.notify.handler.POST(post("/mobile-push/receipts", {}));
      expect(anonymous.status).toBe(401);
    });
  });

  it("prunes devices not seen for staleAfterDays and keeps fresh ones", async () => {
    const fresh = build();
    await register(fresh, T(1));
    const kept = await fresh.notify.handler.POST(machine("/mobile-push/prune"));
    expect(await kept.json()).toEqual({ removed: 0 });

    // A zero-day window makes every row older than "now" stale.
    const strict = build({ staleAfterDays: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const pruned = await strict.notify.handler.POST(machine("/mobile-push/prune"));
    expect(await pruned.json()).toEqual({ removed: 1 });
    expect(await devices()).toHaveLength(0);
  });
});
