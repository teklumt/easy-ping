"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Channel, Frequency } from "../../core/types";
import type { PreferenceView, UpdatePreferenceInput } from "./client";

export type UsePreferencesOptions = {
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
};

export type PreferenceKey = { type: string; channel: Channel };

export type UsePreferencesResult = {
  preferences: readonly PreferenceView[];
  defaultEnabled: boolean;
  isLoading: boolean;
  error: Error | null;
  /** Resolved value for a cell, falling back to the configured default. */
  isEnabled: (key: PreferenceKey) => boolean;
  setEnabled: (key: PreferenceKey, enabled: boolean) => Promise<void>;
  setFrequency: (key: PreferenceKey, frequency: Frequency) => Promise<void>;
  refresh: () => Promise<void>;
};

const matches = (row: PreferenceView, key: PreferenceKey) =>
  row.type === key.type && row.channel === key.channel;

/** Headless: state and persistence only, no markup. */
export function usePreferences(options: UsePreferencesOptions = {}): UsePreferencesResult {
  const { baseUrl = "/api/notifications", fetch: providedFetch } = options;

  const doFetch = useMemo(
    () =>
      providedFetch ??
      ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args)),
    [providedFetch],
  );

  const [preferences, setPreferences] = useState<readonly PreferenceView[]>([]);
  const [defaultEnabled, setDefaultEnabled] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await doFetch(`${baseUrl}/preferences`);
      if (!response.ok) throw new Error(`GET /preferences failed: ${response.status}`);

      const body = (await response.json()) as {
        preferences: PreferenceView[];
        defaultEnabled: boolean;
      };

      setPreferences(body.preferences);
      setDefaultEnabled(body.defaultEnabled);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, doFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = useCallback(
    async (input: UpdatePreferenceInput, optimistic: Partial<PreferenceView>) => {
      const previous = preferences;

      // Optimistic: apply now, revert on failure.
      setPreferences((rows) => {
        const existing = rows.find((row) => matches(row, input));
        if (existing) {
          return rows.map((row) => (matches(row, input) ? { ...row, ...optimistic } : row));
        }
        return [
          ...rows,
          {
            userId: "",
            type: input.type,
            channel: input.channel,
            enabled: true,
            frequency: "instant" as Frequency,
            ...optimistic,
          },
        ];
      });

      try {
        const response = await doFetch(`${baseUrl}/preferences`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error(`POST /preferences failed: ${response.status}`);
      } catch (caught) {
        setPreferences(previous);
        setError(caught instanceof Error ? caught : new Error(String(caught)));
        throw caught;
      }
    },
    [baseUrl, doFetch, preferences],
  );

  return {
    preferences,
    defaultEnabled,
    isLoading,
    error,

    isEnabled: useCallback(
      (key: PreferenceKey) => {
        const row = preferences.find((candidate) => matches(candidate, key));
        return row ? row.enabled && row.frequency !== "off" : defaultEnabled;
      },
      [preferences, defaultEnabled],
    ),

    setEnabled: useCallback(
      (key: PreferenceKey, enabled: boolean) =>
        persist(
          { ...key, enabled, frequency: enabled ? "instant" : "off" },
          { enabled, frequency: enabled ? "instant" : "off" },
        ),
      [persist],
    ),

    setFrequency: useCallback(
      (key: PreferenceKey, frequency: Frequency) =>
        persist(
          { ...key, enabled: frequency !== "off", frequency },
          { enabled: frequency !== "off", frequency },
        ),
      [persist],
    ),

    refresh,
  };
}

export type { PreferenceView, UpdatePreferenceInput } from "./client";
