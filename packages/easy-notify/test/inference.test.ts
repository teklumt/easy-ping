import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { defineNotification } from "../src/index";

type CommentReply = { authorName: string; commentId: string };

const commentReplySchema: StandardSchemaV1<CommentReply, CommentReply> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as CommentReply }),
    types: { input: {} as CommentReply, output: {} as CommentReply },
  },
};

describe("payload inference", () => {
  it("threads the schema output into email callbacks", () => {
    const definition = defineNotification({
      schema: commentReplySchema,
      channels: ["inApp", "email"],
      email: {
        subject: (payload) => `${payload.authorName} replied to you`,
        template: (payload) => payload.commentId,
      },
    });

    expect(definition.email?.subject({ authorName: "Dana", commentId: "c_123" })).toBe(
      "Dana replied to you",
    );
  });

  it("falls back to an open record when no schema is declared", () => {
    const definition = defineNotification({
      channels: ["inApp"],
      email: {
        subject: (payload) => String(payload.anything),
        template: (payload) => JSON.stringify(payload),
      },
    });

    expect(definition.channels).toEqual(["inApp"]);
  });
});
