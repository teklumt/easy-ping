// Runs on the oldest Node in `engines`, against the built bundles.
//
// The floor is 20, not 18: Node 18 has no globalThis.crypto without a flag,
// so randomUUID, subtle and the HMAC token signer are all absent there. The
// package shipped claiming >=18 until CI happened to prove otherwise.

import { mongoAdapter } from "../dist/adapters/mongodb.js";
import { postgresAdapter } from "../dist/adapters/postgres.js";
import { createNotifyClient } from "../dist/client.js";
import { expiresIn, signToken, verifyToken } from "../dist/index.js";
import { coreSchema, renderDrizzleSchema, renderPostgresDdl } from "../dist/schema.js";

const failures = [];
const check = (name, ok) => {
  if (!ok) failures.push(name);
};

check("globalThis.crypto", typeof globalThis.crypto?.subtle?.importKey === "function");
check("crypto.randomUUID", typeof globalThis.crypto?.randomUUID === "function");
check("Response.json", typeof Response.json === "function");
check("globalThis.fetch", typeof globalThis.fetch === "function");
check("AbortController", typeof AbortController === "function");
check("btoa/atob", typeof btoa === "function" && typeof atob === "function");

// Bail before the functional checks: without globalThis.crypto they throw a
// bare ReferenceError, which buries the actual finding under a stack trace.
if (failures.length > 0) {
  console.error(`node ${process.version}: ${failures.length} missing API(s)`);
  for (const name of failures) console.error(`  MISS ${name}`);
  console.error("\nEither raise `engines.node` or stop using the missing API.");
  process.exit(1);
}

const secret = "node-floor-secret";
const token = await signToken(secret, { uid: "u1", purpose: "floor", exp: expiresIn(60) });
check(
  "signToken/verifyToken round trip",
  (await verifyToken(secret, token, "floor"))?.uid === "u1",
);
check("verifyToken rejects wrong purpose", (await verifyToken(secret, token, "other")) === null);

check("renderDrizzleSchema", renderDrizzleSchema(coreSchema).includes("pgTable"));
check("renderPostgresDdl", renderPostgresDdl(coreSchema).length > 0);
check("createNotifyClient", typeof createNotifyClient({}).subscribe === "function");

// The mongo adapter takes the driver structurally, so it must construct with
// no `mongodb` installed. Importing it is the check.
check("mongoAdapter", mongoAdapter({ collection: () => ({}) }).name === "mongodb");

// Takes a bare query function, so it must construct with no driver at all.
check("postgresAdapter", postgresAdapter(async () => []).name === "postgres");

if (failures.length > 0) {
  console.error(`node ${process.version}: ${failures.length} failure(s)`);
  for (const name of failures) console.error(`  MISS ${name}`);
  console.error("\nEither raise `engines.node` or stop using the missing API.");
  process.exit(1);
}

console.log(`node ${process.version}: runtime floor ok`);
