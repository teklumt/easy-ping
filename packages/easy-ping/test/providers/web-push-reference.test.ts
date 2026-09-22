import crypto from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error — http_ece ships no types.
import ece from "http_ece";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateVapidKeys, webPush } from "../../src/providers/web-push";

/**
 * Checks our aes128gcm against an implementation we did not write.
 *
 * test/helpers/web-push.ts decrypts with code written from the same RFC, so a
 * shared misreading of RFC 8291 would agree with itself and disagree with
 * every browser. http_ece is what the `web-push` npm package — and therefore
 * most of the Node ecosystem — actually uses. Agreeing with it is independent
 * evidence that a real service worker can read what we send.
 */

const b64 = (bytes: Buffer | Uint8Array) => Buffer.from(bytes).toString("base64url");

let service: Server;
let origin: string;
let received: Buffer[] = [];

function subscriber(endpoint: string) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh,
    auth,
    subscription: { endpoint, keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } },
  };
}

describe("web push against the reference implementation", () => {
  beforeAll(async () => {
    service = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push(Buffer.concat(chunks));
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => service.close(() => resolve()));
  });

  it("http_ece decrypts what our provider sends", async () => {
    received = [];
    const vapid = await generateVapidKeys();
    const target = subscriber(`${origin}/push/ref`);

    const payload = { title: "Deploy finished", body: "main is live", data: { id: "n_1" } };
    await webPush({ subject: "mailto:ops@acme.dev", vapid, allowInsecureEndpoints: true }).send({
      ...payload,
      subscription: target.subscription,
    });

    const body = received[0];
    if (!body) throw new Error("nothing was sent");

    const plaintext = ece.decrypt(body, {
      version: "aes128gcm",
      privateKey: target.ecdh,
      authSecret: b64(target.auth),
    }) as Buffer;

    expect(JSON.parse(plaintext.toString("utf8"))).toEqual(payload);
  });

  it("emits a well-formed RFC 8188 header", async () => {
    received = [];
    const vapid = await generateVapidKeys();
    await webPush({ subject: "mailto:ops@acme.dev", vapid, allowInsecureEndpoints: true }).send({
      title: "t",
      body: "b",
      subscription: subscriber(`${origin}/push/header`).subscription,
    });

    const body = received[0];
    if (!body) throw new Error("nothing was sent");

    // salt(16) | rs(4) | idlen(1) | keyid(65)
    expect(body.subarray(0, 16).some((byte) => byte !== 0)).toBe(true);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.readUInt8(20)).toBe(65);
  });

  it("a fresh salt per send, so identical content differs on the wire", async () => {
    received = [];
    const vapid = await generateVapidKeys();
    const target = subscriber(`${origin}/push/salt`);
    const provider = webPush({
      subject: "mailto:ops@acme.dev",
      vapid,
      allowInsecureEndpoints: true,
    });
    const message = { title: "same", body: "same", subscription: target.subscription };

    await provider.send(message);
    await provider.send(message);

    // A repeated salt under AES-GCM leaks the plaintext.
    expect(
      received[0]?.subarray(0, 16).equals(received[1]?.subarray(0, 16) ?? Buffer.alloc(0)),
    ).toBe(false);
  });
});
