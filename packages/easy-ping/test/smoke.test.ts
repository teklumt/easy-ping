import { describe, expect, it } from "vitest";
import type { Channel, DeliveryMode, DeliveryStatus } from "../src/index";

describe("package entry", () => {
  it("exposes the core unions", () => {
    const channels: Channel[] = ["inApp", "email", "push", "sms", "slack"];
    const statuses: DeliveryStatus[] = ["pending", "claimed", "sent", "failed", "skipped"];
    const modes: DeliveryMode[] = ["inline", "deferred", "worker", "cron"];

    expect(channels).toHaveLength(5);
    expect(statuses).toHaveLength(5);
    expect(modes).toHaveLength(4);
  });
});
