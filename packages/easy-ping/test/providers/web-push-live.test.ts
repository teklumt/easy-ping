import crypto from "node:crypto";
// @ts-expect-error — http_ece ships no types.
import ece from "http_ece";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateVapidKeys, webPush } from "../../src/providers/web-push";

// A real push through Mozilla's production service; opt-in with EASY_PING_LIVE_PUSH=1.

const live = process.env.EASY_PING_LIVE_PUSH === "1";
const AUTOPUSH = "wss://push.services.mozilla.com";

const b64 = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString("base64url");

type Frame = { messageType: string; [key: string]: unknown };

let socket: WebSocket;
const inbox: Frame[] = [];

/** Frames arrive unordered relative to our requests, so match on type. */
function waitFor(type: string, timeoutMs = 30_000): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      const index = inbox.findIndex((frame) => frame.messageType === type);
      if (index >= 0) {
        clearInterval(tick);
        resolve(inbox.splice(index, 1)[0] as Frame);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(tick);
        reject(new Error(`timed out waiting for a "${type}" frame`));
      }
    }, 100);
  });
}

describe.skipIf(!live)("web push against a live push service", () => {
  beforeAll(async () => {
    // Node 22+ has a global WebSocket, so this needs no dependency.
    socket = new WebSocket(AUTOPUSH);
    socket.addEventListener("message", (event) => inbox.push(JSON.parse(String(event.data))));

    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot reach ${AUTOPUSH}`)), {
        once: true,
      });
    });

    socket.send(JSON.stringify({ messageType: "hello", use_webpush: true }));
    await waitFor("hello");
  }, 60_000);

  afterAll(() => socket?.close());

  /** Registers a real channel and returns a browser-shaped subscription. */
  async function subscribe(applicationServerKey: string) {
    const channelID = crypto.randomUUID();
    socket.send(JSON.stringify({ messageType: "register", channelID, key: applicationServerKey }));

    const registered = await waitFor("register");
    expect(registered.status).toBe(200);

    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);

    return {
      channelID,
      ecdh,
      auth,
      subscription: {
        endpoint: String(registered.pushEndpoint),
        keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) },
      },
    };
  }

  it("delivers a payload the subscriber decrypts, byte for byte", async () => {
    const vapid = await generateVapidKeys();
    const target = await subscribe(vapid.publicKey);

    expect(target.subscription.endpoint).toContain("updates.push.services.mozilla.com");

    const payload = {
      title: "easy-ping",
      body: "through a production push service",
      data: { notificationId: crypto.randomUUID() },
    };

    const result = await webPush({ subject: "mailto:ops@acme.dev", vapid }).send({
      ...payload,
      subscription: target.subscription,
    });
    expect(result).toEqual({});

    const notification = await waitFor("notification");
    const ciphertext = Buffer.from(String(notification.data), "base64url");

    const plaintext = ece.decrypt(ciphertext, {
      version: "aes128gcm",
      privateKey: target.ecdh,
      authSecret: b64(target.auth),
    }) as Buffer;

    expect(JSON.parse(plaintext.toString("utf8"))).toEqual(payload);
  }, 60_000);

  it("is rejected when signed with a key the channel was not registered for", async () => {
    // Without this the test above proves only that Mozilla accepted something,
    // not that it checked anything.
    const vapid = await generateVapidKeys();
    const impostor = await generateVapidKeys();
    const target = await subscribe(vapid.publicKey);

    await expect(
      webPush({ subject: "mailto:ops@acme.dev", vapid: impostor }).send({
        title: "t",
        body: "b",
        subscription: target.subscription,
      }),
    ).rejects.toThrow(/401/);
  }, 60_000);

  it("reports an unsubscribed endpoint as expired, so the device is pruned", async () => {
    const vapid = await generateVapidKeys();
    const target = await subscribe(vapid.publicKey);

    socket.send(JSON.stringify({ messageType: "unregister", channelID: target.channelID }));
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const result = await webPush({ subject: "mailto:ops@acme.dev", vapid }).send({
      title: "t",
      body: "b",
      subscription: target.subscription,
    });

    expect(result).toEqual({ expired: true });
  }, 60_000);
});
