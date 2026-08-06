import type { Backoff } from "./backoff";
import type { EasyNotify, EasyNotifyConfig, HealthReport, SendArgs, SendResult } from "./config";
import type { NotificationDefinitions } from "./definition";
import { ConfigError, consoleLogger } from "./errors";
import { createHandler } from "./handler";
import type { AnyPlugin } from "./plugin";
import { createRunner } from "./runner";
import { runSend } from "./send";
import type { DeliveryMode } from "./types";

const DEFAULTS = {
  maxAttempts: 5,
  leaseMs: 60_000,
  batchSize: 20,
  basePath: "/api/notifications",
  mode: "cron" as DeliveryMode,
};

function validate(
  config: EasyNotifyConfig<NotificationDefinitions>,
  plugins: readonly AnyPlugin[],
) {
  if (!config.database) throw new ConfigError("`database` is required.");
  if (!config.notifications) throw new ConfigError("`notifications` is required.");

  // No default resolver and no dev bypass: the inbox endpoints serve per-user
  // data, and an insecure default ships where a startup crash does not.
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

  // Two plugins claiming the same route silently shadow each other otherwise,
  // and which one wins depends on registration order.
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

export function easyNotify<TDefs extends NotificationDefinitions>(
  config: EasyNotifyConfig<TDefs>,
): EasyNotify<TDefs> {
  const plugins = config.plugins ?? [];
  validate(config as EasyNotifyConfig<NotificationDefinitions>, plugins);

  const logger = config.logger ?? consoleLogger;
  const mode = config.delivery?.mode ?? DEFAULTS.mode;
  const leaseMs = config.delivery?.leaseMs ?? DEFAULTS.leaseMs;
  const warnings: string[] = [];

  // Below this ratio a slow send is re-claimed mid-flight, and duplicates stop
  // being occasional and become systematic. RFC 0003 §7.
  const providerTimeout = config.channels.email?.provider?.timeoutMs;
  if (providerTimeout !== undefined && providerTimeout >= leaseMs / 2) {
    warnings.push(
      `email provider timeout (${providerTimeout}ms) is at least half of delivery.leaseMs ` +
        `(${leaseMs}ms); raise leaseMs or duplicate sends become systematic.`,
    );
  }

  if (mode === "deferred" && !config.delivery?.waitUntil) {
    warnings.push(
      "delivery.mode is 'deferred' but no delivery.waitUntil was supplied; " +
        "delivery will wait for the cron sweep.",
    );
  }

  for (const warning of warnings) logger.warn(warning);

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
  });

  const pluginRoutes = plugins.flatMap((plugin) => plugin.routes ?? []);

  const handler = createHandler({
    adapter: config.database,
    session: config.session,
    runner,
    logger,
    secret: config.secret,
    basePath: config.basePath ?? DEFAULTS.basePath,
    pluginRoutes,
    ...(config.cron?.secret ? { cronSecret: config.cron.secret } : {}),
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

    // The rows are committed by this point, so every branch below only affects
    // latency — never whether the notification survives. RFC 0001 §8.1.
    if (result.notifications.length > 0) {
      // Scoped to this send's deliveries. Unscoped, a single inline send in a
      // request handler flushes the whole backlog.
      const ids = result.notifications.flatMap((notification) =>
        notification.deliveries.map((delivery) => delivery.id),
      );

      if (mode === "inline") await runner.drain({ ids });
      else if (mode === "deferred") runner.scheduleDeferred(config.delivery?.waitUntil, ids);
    }

    return result;
  }

  return {
    send,
    handler,

    startWorker: (options) => runner.startWorker(options ?? {}),

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
