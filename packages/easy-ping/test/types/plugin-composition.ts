import type { StandardSchemaV1 } from "@standard-schema/spec";
import { defineNotification } from "../../src/core/definition";
import type { ActionsOf } from "../../src/core/plugin";
import { defineClientPlugin } from "../../src/core/plugin";
import type { PreferenceView, UpdatePreferenceInput } from "../../src/plugins/preferences/client";
import { preferencesClient } from "../../src/plugins/preferences/client";

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

const preferences = defineClientPlugin({
  id: "preferences",
  actions: () => ({
    updatePreference: async (input: { type: string; channel: string; enabled: boolean }) =>
      input.enabled,
  }),
});

const digests = defineClientPlugin({
  id: "digests",
  actions: () => ({
    setDigestWindow: async (input: { frequency: "daily" | "weekly" }) => input.frequency,
  }),
});

const push = defineClientPlugin({
  id: "push",
  actions: () => ({
    registerDevice: async (input: { token: string }) => ({ deviceId: input.token }),
    unregisterDevice: async (input: { deviceId: string }) => input.deviceId.length > 0,
  }),
});

const realtime = defineClientPlugin({
  id: "realtime",
  actions: () => ({
    subscribe: (handler: (event: { id: string }) => void) => () => handler({ id: "noop" }),
  }),
});

const batching = defineClientPlugin({
  id: "batching",
  actions: () => ({
    expandGroup: async (input: { groupKey: string }) => [input.groupKey],
  }),
});

const slack = defineClientPlugin({
  id: "slack",
  actions: () => ({
    linkWorkspace: async (input: { teamId: string }) => ({ linked: true, teamId: input.teamId }),
  }),
});

// The real plugin, not a fixture — this is what proves RFC 0004 §2 works in
// practice rather than only against hand-written stand-ins.
const realPreferences = preferencesClient();

type WithRealPlugin = ActionsOf<[typeof realPreferences]>;

export type _RealUpdatePreference = Expect<
  Equal<
    WithRealPlugin["updatePreference"],
    (input: UpdatePreferenceInput) => Promise<{ ok: boolean }>
  >
>;

export type _RealListPreferences = Expect<
  Equal<
    WithRealPlugin["listPreferences"],
    () => Promise<{ preferences: PreferenceView[]; defaultEnabled: boolean }>
  >
>;

type SixPlugins = [
  typeof preferences,
  typeof digests,
  typeof push,
  typeof realtime,
  typeof batching,
  typeof slack,
];

type Merged = ActionsOf<SixPlugins>;

// Every action survives the merge with its exact signature.
export type _UpdatePreference = Expect<
  Equal<
    Merged["updatePreference"],
    (input: { type: string; channel: string; enabled: boolean }) => Promise<boolean>
  >
>;

export type _SetDigestWindow = Expect<
  Equal<
    Merged["setDigestWindow"],
    (input: { frequency: "daily" | "weekly" }) => Promise<"daily" | "weekly">
  >
>;

export type _RegisterDevice = Expect<
  Equal<Merged["registerDevice"], (input: { token: string }) => Promise<{ deviceId: string }>>
>;

export type _UnregisterDevice = Expect<
  Equal<Merged["unregisterDevice"], (input: { deviceId: string }) => Promise<boolean>>
>;

export type _Subscribe = Expect<
  Equal<Merged["subscribe"], (handler: (event: { id: string }) => void) => () => void>
>;

export type _ExpandGroup = Expect<
  Equal<Merged["expandGroup"], (input: { groupKey: string }) => Promise<string[]>>
>;

export type _LinkWorkspace = Expect<
  Equal<
    Merged["linkWorkspace"],
    (input: { teamId: string }) => Promise<{ linked: boolean; teamId: string }>
  >
>;

// Payload inference still resolves with six plugins in scope.
type CommentReply = { authorName: string; commentId: string };

declare const commentReplySchema: StandardSchemaV1<CommentReply, CommentReply>;

const commentReply = defineNotification({
  schema: commentReplySchema,
  channels: ["inApp", "email"],
  email: {
    subject: (payload) => payload.authorName,
    template: (payload) => payload.commentId,
  },
});

export type _PayloadStillInfers = Expect<
  Equal<Parameters<NonNullable<typeof commentReply.email>["subject"]>[0], CommentReply>
>;
