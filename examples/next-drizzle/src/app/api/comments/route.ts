import { randomUUID } from "node:crypto";
import { z } from "zod";
import { notify } from "../../../notify";
import { getSession } from "../../../session";

const Body = z.object({ threadOwnerId: z.string().min(1).max(40) });

export async function POST(request: Request) {
  const session = await getSession(request);
  if (!session) return new Response(null, { status: 401 });

  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "threadOwnerId is required" }, { status: 400 });

  // Stands in for the comment your app just saved.
  const commentId = randomUUID();
  const { threadOwnerId } = body.data;

  // Returns as soon as the rows are committed; it does not wait for Resend.
  // The payload is typed against the zod schema in notify.ts, so a typo is a compile error.
  const result = await notify.send("commentReply", {
    to: threadOwnerId,
    payload: { authorName: session.userId, commentId },
    actorId: session.userId,
    // Safe to call twice: a retried request will not double-notify.
    dedupeKey: `commentReply:${commentId}:${threadOwnerId}`,
  });

  return Response.json(result);
}
