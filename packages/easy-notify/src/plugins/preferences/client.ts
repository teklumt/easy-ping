import { defineClientPlugin } from "../../core/plugin";
import type { Channel, Frequency } from "../../core/types";
import type { preferences } from "./index";

export type PreferenceView = {
  userId: string;
  type: string;
  channel: Channel;
  enabled: boolean;
  frequency: Frequency;
};

export type UpdatePreferenceInput = {
  type: string;
  channel: Channel;
  enabled?: boolean;
  frequency?: Frequency;
};

/** Paired by phantom type: importing the server plugin's value would bundle the DB. */
export const preferencesClient = () =>
  defineClientPlugin({
    id: "preferences",
    $InferServerPlugin: {} as ReturnType<typeof preferences>,

    actions: (fetch) => ({
      listPreferences: async (): Promise<{
        preferences: PreferenceView[];
        defaultEnabled: boolean;
      }> =>
        (await fetch("/preferences")) as {
          preferences: PreferenceView[];
          defaultEnabled: boolean;
        },

      updatePreference: async (input: UpdatePreferenceInput): Promise<{ ok: boolean }> =>
        (await fetch("/preferences", {
          method: "POST",
          body: JSON.stringify(input),
        })) as { ok: boolean },
    }),
  });

export type PreferencesClient = ReturnType<typeof preferencesClient>;
