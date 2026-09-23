/**
 * The service-worker half of the push relay (RFC 0006 idea 4).
 *
 *     import { handlePush } from "easy-ping/sw";
 *     self.addEventListener("push", (event) => event.waitUntil(handlePush(event)));
 *
 * Shows the OS notification the push was sent for, then tells every open tab
 * on this origin that the inbox changed, so the bell refreshes without a poll.
 * Nothing here imports service-worker types: the globals are taken
 * structurally so the file compiles under the DOM lib.
 */

export type PushPayload = {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
};

export type RelayMessage = {
  source: "easy-ping";
  type: "changed";
  notificationId?: string;
};

export const isRelayMessage = (value: unknown): value is RelayMessage => {
  const message = value as Partial<RelayMessage> | null;
  return message?.source === "easy-ping" && message.type === "changed";
};

type PushEventLike = { data: { json(): unknown } | null };

type ServiceWorkerScopeLike = {
  registration: {
    showNotification(title: string, options?: Record<string, unknown>): Promise<void>;
  };
  clients: {
    matchAll(options?: {
      type?: "window";
      includeUncontrolled?: boolean;
    }): Promise<{ postMessage(message: unknown): void }[]>;
  };
};

export type HandlePushOptions = {
  /** Override what the OS notification shows. Default: the payload's title and body. */
  render?: (payload: PushPayload) => { title: string; options?: Record<string, unknown> };
  /** Skip the OS notification. Browsers ration silent pushes; leave this on unless you know why. */
  showNotification?: boolean;
};

export async function handlePush(
  event: PushEventLike,
  options: HandlePushOptions = {},
  scope: ServiceWorkerScopeLike = globalThis as unknown as ServiceWorkerScopeLike,
): Promise<void> {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    payload = {};
  }

  const notificationId =
    typeof payload.data?.notificationId === "string" ? payload.data.notificationId : undefined;

  if (options.showNotification !== false) {
    const rendered = options.render?.(payload) ?? {
      title: payload.title ?? "Notification",
      options: {
        body: payload.body ?? "",
        data: payload.data ?? {},
        ...(notificationId ? { tag: notificationId } : {}),
      },
    };
    await scope.registration.showNotification(rendered.title, rendered.options);
  }

  const message: RelayMessage = {
    source: "easy-ping",
    type: "changed",
    ...(notificationId ? { notificationId } : {}),
  };
  const tabs = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const tab of tabs) tab.postMessage(message);
}
