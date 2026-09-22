import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { defineNotification, easyPing } from "easy-ping";
import { toNodeHandler } from "easy-ping/node";
import { preferences } from "easy-ping/plugins/preferences";
import { push } from "easy-ping/plugins/push";
import { webPush } from "easy-ping/providers/web-push";
import { connect, type Driver } from "./database.ts";

const env = (key: string, fallback?: string) => {
  const value = process.env[key] ?? fallback;
  if (!value) throw new Error(`${key} is not set — copy .env.example to .env and fill it in`);
  return value;
};

// Identity here is a request header anyone can set. This must never face the internet.
if (process.env.NODE_ENV === "production") {
  throw new Error(
    "the demo trusts an x-demo-user header for identity and cannot run in production",
  );
}

const DB_DRIVER = env("DB_DRIVER", "postgres") as Driver;
const VAPID_PUBLIC_KEY = env("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = env("VAPID_PRIVATE_KEY");

if (DB_DRIVER !== "postgres" && DB_DRIVER !== "mongodb") {
  throw new Error(`DB_DRIVER must be "postgres" or "mongodb", got "${DB_DRIVER}"`);
}

const pushPlugin = push({
  provider: webPush({
    subject: process.env.VAPID_SUBJECT ?? "mailto:demo@example.com",
    vapid: { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY },
  }),
  // The demo talks to real push services, so the production defaults apply.
  render: ({ type, payload }) => {
    const data = payload as { title?: string; body?: string };
    return { title: data.title ?? type, body: data.body ?? "You have a new notification" };
  },
});

const preferencesPlugin = preferences();

const { adapter, label } = await connect(DB_DRIVER, [
  pushPlugin.schema ?? {},
  preferencesPlugin.schema ?? {},
]);

const notify = easyPing({
  database: adapter,
  secret: env("NOTIFY_SECRET"),
  cron: { secret: env("NOTIFY_CRON_SECRET") },

  // A demo stand-in for real auth: the browser sends whoever it is.
  session: { getUserId: async (request) => request.headers.get("x-demo-user") ?? "demo-user" },

  getRecipients: async (ids) =>
    ids.map((userId) => ({
      userId,
      email: `${userId}@example.com`,
      timezone: "UTC",
      locale: "en",
    })),

  channels: { inApp: { enabled: true } },

  // Delivered as soon as send() returns, so the demo needs no cron.
  delivery: { mode: "inline" },

  notifications: {
    demoPing: defineNotification({ channels: ["inApp", "push"] }),
  },

  plugins: [preferencesPlugin, pushPlugin],
});

const notifyHandler = toNodeHandler(notify.handler.handle);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/notifications")) {
    return void notifyHandler(req, res);
  }

  // Sends to whoever is asking, so one browser can notify itself.
  if (url.pathname === "/api/demo/send" && req.method === "POST") {
    const userId = req.headers["x-demo-user"];

    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

    let message = "";
    try {
      message = String(JSON.parse(body || "{}").message ?? "").slice(0, 200);
    } catch {
      // A malformed body just falls back to the default text.
    }

    const result = await notify.send("demoPing", {
      to: typeof userId === "string" ? userId : "demo-user",
      payload: {
        title: "easy-ping",
        body: message || `Sent at ${new Date().toLocaleTimeString()}`,
      },
    });

    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify(result));
  }

  if (url.pathname === "/api/demo/config") {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ vapidPublicKey: VAPID_PUBLIC_KEY }));
  }

  // Served straight out of the workspace package so they track a rebuild.
  const BUNDLES: Record<string, string> = {
    "/easy-ping-browser.js": "browser.js",
    "/easy-ping-client.js": "client.js",
  };

  const bundle = BUNDLES[url.pathname];
  if (bundle) {
    const path = join(import.meta.dirname, "..", "node_modules", "easy-ping", "dist", bundle);
    try {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return void res.end(await readFile(path));
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      return void res.end(`${bundle} is missing — run \`pnpm --filter easy-ping build\` first`);
    }
  }

  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  try {
    const body = await readFile(join(import.meta.dirname, "..", "public", file));
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      // The worker must be allowed to control the whole origin.
      ...(file === "/sw.js" ? { "service-worker-allowed": "/" } : {}),
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(3210, "127.0.0.1", () => {
  console.log("\n  easy-ping demo -> http://localhost:3210");
  console.log(`  database: ${label}\n`);
});
