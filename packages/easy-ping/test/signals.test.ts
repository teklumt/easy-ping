import { describe, expect, it } from "vitest";
import {
  createBridgedSignals,
  createMemorySignals,
  DELIVERIES_CHANNEL,
  inboxChannel,
} from "../src/core/signals";
import { waitUntil } from "./helpers/wait";

describe("memory signals", () => {
  it("fans out to every subscriber of the channel and nobody else", async () => {
    const signals = createMemorySignals();
    const seen: string[] = [];
    signals.subscribe(inboxChannel("u1"), () => seen.push("a"));
    signals.subscribe(inboxChannel("u1"), () => seen.push("b"));
    signals.subscribe(inboxChannel("u2"), () => seen.push("other"));

    signals.publish(inboxChannel("u1"));
    await waitUntil(() => seen.length === 2);

    expect(seen.sort()).toEqual(["a", "b"]);
    expect(signals.crossProcess).toBe(false);
  });

  it("stops delivering after unsubscribe", async () => {
    const signals = createMemorySignals();
    let hits = 0;
    const off = signals.subscribe(DELIVERIES_CHANNEL, () => {
      hits += 1;
    });
    signals.publish(DELIVERIES_CHANNEL);
    await waitUntil(() => hits === 1);

    off();
    signals.publish(DELIVERIES_CHANNEL);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hits).toBe(1);
  });

  it("one throwing handler does not starve the others", async () => {
    const signals = createMemorySignals();
    let reached = false;
    signals.subscribe("x", () => {
      throw new Error("boom");
    });
    signals.subscribe("x", () => {
      reached = true;
    });
    signals.publish("x");
    await waitUntil(() => reached);
  });
});

describe("bridged signals", () => {
  function fakeBus() {
    const remote = new Map<string, Set<() => void>>();
    const published: string[] = [];
    return {
      published,
      remote,
      transport: {
        publish: async (channel: string) => {
          published.push(channel);
        },
        subscribe: async (channel: string, handler: () => void) => {
          remote.set(channel, (remote.get(channel) ?? new Set()).add(handler));
          return () => {
            remote.get(channel)?.delete(handler);
          };
        },
      },
      /** What another process would do: the bus tells this one the channel moved. */
      arrive: (channel: string) => {
        for (const handler of remote.get(channel) ?? []) handler();
      },
    };
  }

  it("publishes through the transport and also fans out locally", async () => {
    const bus = fakeBus();
    const signals = createBridgedSignals(bus.transport, () => {});
    let local = 0;
    signals.subscribe("c", () => {
      local += 1;
    });

    signals.publish("c");
    await waitUntil(() => local === 1 && bus.published.length === 1);
    expect(signals.crossProcess).toBe(true);
  });

  it("delivers remote arrivals to local subscribers and drops the remote subscription with the last local one", async () => {
    const bus = fakeBus();
    const signals = createBridgedSignals(bus.transport, () => {});
    let hits = 0;
    const offA = signals.subscribe("c", () => {
      hits += 1;
    });
    const offB = signals.subscribe("c", () => {
      hits += 1;
    });
    await waitUntil(() => (bus.remote.get("c")?.size ?? 0) === 1);

    bus.arrive("c");
    await waitUntil(() => hits === 2);

    offA();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bus.remote.get("c")?.size).toBe(1);

    offB();
    await waitUntil(() => (bus.remote.get("c")?.size ?? 0) === 0);
  });
});
