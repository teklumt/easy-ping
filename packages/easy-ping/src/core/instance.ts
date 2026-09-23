import type { Backoff } from "./backoff";
import {
  type EasyPing,
  type EasyPingConfig,
  type HealthReport,
  INBOX_VERSION_HEADER,
  type MountedRoute,
  type SendArgs,
  type SendResult,
} from "./config";
import type { NotificationDefinitions } from "./definition";
import { ConfigError, consoleLogger } from "./errors";
import { createHandler } from "./handler";
import type { AnyPlugin } from "./plugin";
import { createRateLimiter } from "./rate-limit";
import { createRunner } from "./runner";
import { isChannelUsable, runSend } from "./send";
import { createMemorySignals, DELIVERIES_CHANNEL, inboxChannel, type Signals } from "./signals";
import { createPluginStore } from "./store";
import { createScopedSigner } from "./tokens";
import type { DeliveryMode } from "./types";

const CORE_ROUTES: readonly MountedRoute[] = [
  { method: "GET", path: "/", scope: { type: "user" }, owner: "core" },
  { method: "GET", path: "/count", scope: { type: "user" }, owner: "core" },
  { method: "POST", path: "/seen", scope: { type: "user" }, owner: "core" },
  { method: "POST", path: "/read", scope: { type: "user" }, owner: "core" },
  { method: "POST", path: "/read-all", scope: { type: "user" }, owner: "core" },
  { method: "GET", path: "/events", scope: { type: "user" }, owner: "core" },
  { method: "POST", path: "/cron", scope: { type: "machine" }, owner: "core" },
];

const DEFAULTS = {
  maxAttempts: 5,
  leaseMs: 60_000,
  batchSize: 20,
  basePath: "/api/notifications",
  mode: "cron" as DeliveryMode,
};

export const MIN_SECRET_LENGTH = 16;

const PLACEHOLDER_SECRETS = new Set([
  "secret",
  "changeme",
  "change-me",
  "replace-me",
  "replace-me-too",
  "password",
  "demo-signing-secret",
  "demo-cron-secret",
]);

function checkSecretStrength(name: string, value: string) {
  if (value.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    throw new ConfigError(
      `\`${name}\` must be at least ${MIN_SECRET_LENGTH} characters and not a placeholder. ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }
}

function validate(config: EasyPingConfig<NotificationDefinitions>, plugins: readonly AnyPlugin[]) {
  if (!config.database) throw new ConfigError("`database` is required.");
  if (!config.notifications) throw new ConfigError("`notifications` is required.");

  // No default resolver and no dev bypass: an insecure default ships, a crash does not.
  if (typeof config.session?.getUserId !== "function") {
    throw new ConfigError(
      "`session.getUserId` is required — the mounted endpoints serve a user's private inbox " +
        "and must resolve the caller. See RFC 0002.",
    );
  }

  if (!config.secret) {
    throw new ConfigError(
      "`secret` is required — it signs unsubscribe and other session-less links. " +
        "Adding it later is a breaking change, so it is mandatory from the start.",
    );
  }
  checkSecretStrength("secret", config.secret);
  if (config.cron?.secret) checkSecretStrength("cron.secret", config.cron.secret);
  if (config.machineSecret) checkSecretStrength("machineSecret", config.machineSecret);

  if (config.rateLimit && (config.rateLimit.max < 1 || config.rateLimit.windowMs < 1)) {
    throw new ConfigError("`rateLimit.max` and `rateLimit.windowMs` must both be positive.");
  }

  if (typeof config.getRecipients !== "function") {
    throw new ConfigError("`getRecipients` is required to resolve emails and timezones.");
  }

  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) {
      throw new ConfigError(`duplicate plugin id "${plugin.id}" — ids must be unique.`);
    }
    seen.add(plugin.id);
  }

  for (const plugin of plugins) {
    for (const dependency of plugin.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        throw new ConfigError(
          `plugin "${plugin.id}" requires "${dependency}", which is not registered.`,
        );
      }
    }
  }

  const routes = new Set<string>();
  for (const plugin of plugins) {
    for (const route of plugin.routes ?? []) {
      const signature = `${route.method} ${route.path}`;
      if (routes.has(signature)) {
        throw new ConfigError(`route collision: two plugins both registered "${signature}".`);
      }
      routes.add(signature);
    }
  }

  const mode = config.delivery?.mode ?? DEFAULTS.mode;
  if ((mode === "cron" || mode === "deferred") && !config.cron?.secret) {
    throw new ConfigError(
      `delivery.mode "${mode}" relies on the cron sweep, so \`cron.secret\` is required. ` +
        "Left unset the endpoint would be unauthenticated — a free flush-everything trigger " +
        "against your email provider. See RFC 0002 §4.",
    );
  }
}

export function easyPing<TDefs extends NotificationDefinitions>(
  config: EasyPingConfig<TDefs>,
): EasyPing<TDefs> {
  const plugins = config.plugins ?? [];
  validate(config as EasyPingConfig<NotificationDefinitions>, plugins);

  const logger = config.logger ?? consoleLogger;
  const tablePrefix = config.tablePrefix ?? "";
  const mode = config.delivery?.mode ?? DEFAULTS.mode;
  const leaseMs = config.delivery?.leaseMs ?? DEFAULTS.leaseMs;
  const warnings: string[] = [];

  // Below this ratio a slow send is re-claimed mid-flight. RFC 0003 §7.
  const providerTimeout = config.channels.email?.provider?.timeoutMs;
  if (providerTimeout !== undefined && providerTimeout >= leaseMs / 2) {
    warnings.push(
      `email provider timeout (${providerTimeout}ms) is at least half of delivery.leaseMs ` +
        `(${leaseMs}ms); raise leaseMs or duplicate sends become systematic.`,
    );
  }

  const unusable = new Map<string, string[]>();
  for (const [type, definition] of Object.entries(config.notifications)) {
    const missing = definition.channels.filter(
      (channel) => !isChannelUsable(channel, config.channels, plugins),
    );
    if (missing.length > 0) unusable.set(type, [...missing]);
  }

  for (const [type, channels] of unusable) {
    const dead = channels.length === config.notifications[type]?.channels.length;
    warnings.push(
      `notification "${type}" declares ${channels.map((c) => `"${c}"`).join(", ")} ` +
        `but no provider is configured for ${channels.length > 1 ? "them" : "it"}` +
        (dead ? " — this type can never be delivered." : "; those channels will be skipped."),
    );
  }

  if (mode === "deferred" && !config.delivery?.waitUntil) {
    warnings.push(
      "delivery.mode is 'deferred' but no delivery.waitUntil was supplied; " +
        "delivery will wait for the cron sweep.",
    );
  }

  // Custom-scoped routes are named at startup with their justification. RFC 0002 §3.
  for (const plugin of plugins) {
    for (const route of plugin.routes ?? []) {
      if (route.scope.type === "custom") {
        warnings.push(
          `plugin "${plugin.id}" mounts ${route.method} ${route.path} with custom auth: ` +
            route.scope.justification,
        );
      }
    }
  }

  for (const warning of warnings) logger.warn(warning);

  const baseSignals = config.signals ?? createMemorySignals();

  // Per-user inbox versions for the piggyback header. In-process counters, so
  // another replica's number differs; the client treats any change as "look",
  // which costs a spurious refresh, never a missed one.
  const inboxVersions = new Map<string, number>();
  const signals: Signals = {
    crossProcess: baseSignals.crossProcess,
    publish(channel) {
      if (channel.startsWith("inbox:")) {
        if (inboxVersions.size > 50_000) inboxVersions.clear();
        const userId = channel.slice("inbox:".length);
        inboxVersions.set(userId, (inboxVersions.get(userId) ?? 0) + 1);
      }
      baseSignals.publish(channel);
    },
    subscribe: (channel, handler) => baseSignals.subscribe(channel, handler),
  };

  const runner = createRunner({
    adapter: config.database,
    definitions: config.notifications,
    channels: config.channels,
    plugins,
    getRecipients: config.getRecipients,
    logger,
    leaseMs,
    batchSize: config.delivery?.batchSize ?? DEFAULTS.batchSize,
    backoff: (config.delivery?.backoff ?? "exponential") as Backoff,
    signals,
  });

  const pluginRoutes = plugins.flatMap((plugin) => plugin.routes ?? []);

  const events =
    config.events === false
      ? false
      : {
          heartbeatMs: config.events?.heartbeatMs ?? 25_000,
          probeIntervalMs: config.events?.probeIntervalMs ?? 30_000,
          maxDurationMs: config.events?.maxDurationMs ?? 0,
          maxStreamsPerUser: config.events?.maxStreamsPerUser ?? 10,
          maxStreams: config.events?.maxStreams ?? 5_000,
        };

  const sweepConfig = config.delivery?.sweepOnRequest;
  let lastRequestSweep = 0;
  const sweepOnRequest =
    sweepConfig && mode !== "inline"
      ? () => {
          const settings = sweepConfig === true ? {} : sweepConfig;
          const now = Date.now();
          if (now - lastRequestSweep < (settings.everyMs ?? 5_000)) return;
          lastRequestSweep = now;
          const pass = runner
            .runOnce({ limit: settings.limit ?? 5 })
            .catch((error) => logger.error("request-driven sweep failed", { error }));
          config.delivery?.waitUntil?.(pass);
        }
      : undefined;

  const handler = createHandler({
    adapter: config.database,
    session: config.session,
    runner,
    logger,
    secret: config.secret,
    signals,
    events,
    sweepOnRequest,
    basePath: config.basePath ?? DEFAULTS.basePath,
    pluginRoutes,
    trustedOrigins: config.trustedOrigins,
    onRequest: config.onRequest,
    maxBodyBytes: config.maxBodyBytes,
    rateLimit: config.rateLimit ? createRateLimiter(config.rateLimit) : undefined,
    cronMaxSweeps: config.cron?.maxSweeps,
    ...(config.cron?.secret ? { cronSecret: config.cron.secret } : {}),
    ...((config.machineSecret ?? config.cron?.secret)
      ? { machineSecret: config.machineSecret ?? config.cron?.secret }
      : {}),
  });

  async function send<TKey extends keyof TDefs & string>(
    type: TKey,
    args: SendArgs<TDefs, TKey>,
  ): Promise<SendResult> {
    const result = await runSend(
      type,
      {
        to: args.to,
        payload: args.payload,
        actorId: args.actorId,
        dedupeKey: args.dedupeKey,
        overrides: args.overrides,
      },
      {
        adapter: config.database,
        definitions: config.notifications,
        channels: config.channels,
        plugins,
        getRecipients: config.getRecipients,
        maxAttempts: config.delivery?.maxAttempts ?? DEFAULTS.maxAttempts,
        logger,
      },
    );

    // Rows are committed; everything below only affects latency. RFC 0001 §8.1.
    if (result.notifications.length > 0) {
      for (const notification of result.notifications) {
        signals.publish(inboxChannel(notification.userId));
      }
      signals.publish(DELIVERIES_CHANNEL);

      // Scoped to this send, or an inline send flushes the whole backlog.
      const ids = result.notifications.flatMap((notification) =>
        notification.deliveries.map((delivery) => delivery.id),
      );

      if (mode === "inline") await runner.drain({ ids });
      else if (mode === "deferred") runner.scheduleDeferred(config.delivery?.waitUntil, ids);
    }

    return result;
  }

  // After send() exists, before any hook or route can run.
  for (const plugin of plugins) {
    const purposes = new Set(
      (plugin.routes ?? []).flatMap((route) =>
        route.scope.type === "signed" ? [route.scope.purpose] : [],
      ),
    );
    plugin.init?.({
      store: createPluginStore(plugin.id, plugin.schema, config.database, tablePrefix),
      sign: createScopedSigner(
        config.secret,
        plugin.id,
        purposes,
        (message) => new ConfigError(message),
      ),
      logger,
      notificationTypes: Object.keys(config.notifications),
      getRecipients: config.getRecipients,
      send: (type, args) => send(type as keyof TDefs & string, args as never) as Promise<unknown>,
    });
  }

  return {
    send,
    handler,

    startWorker: (options) => runner.startWorker(options ?? {}),

    inboxHeaders: (userId) => ({
      [INBOX_VERSION_HEADER]: String(inboxVersions.get(userId) ?? 0),
    }),

    listRoutes: () => [
      ...CORE_ROUTES.filter(
        (route) =>
          (route.path !== "/cron" || Boolean(config.cron?.secret)) &&
          (route.path !== "/events" || events !== false),
      ),
      ...plugins.flatMap((plugin) =>
        (plugin.routes ?? []).map((route) => ({
          method: route.method,
          path: route.path,
          scope: route.scope,
          owner: plugin.id,
        })),
      ),
    ],

    getFailedDeliveries: (options = {}) =>
      config.database.getFailedDeliveries({
        since: options.since ?? new Date(Date.now() - 24 * 3600_000),
        limit: Math.min(options.limit ?? 100, 1000),
      }),

    healthCheck: async (): Promise<HealthReport> => {
      const cronMounted = Boolean(config.cron?.secret);
      return {
        mode,
        cronMounted,
        cronRequiredButMissing:
          !cronMounted && (mode === "cron" || mode === "deferred" || mode === "inline"),
        warnings,
      };
    },
  };
}
