import { notify } from "../../../notify";
import { getSession } from "../../../session";

export async function POST(request: Request) {
  const session = await getSession(request);
  if (!session) return new Response(null, { status: 401 });

  const { commentId, threadOwnerId } = (await request.json()) as {
    commentId: string;
    threadOwnerId: string;
  };

  // Returns as soon as the rows are committed — it does not wait for Resend.
  // The payload is typed against the zod schema in notify.ts; a typo here is
  // a compile error, not a runtime surprise.
  await notify.send("commentReply", {
    to: threadOwnerId,
    payload: { authorName: "Dana", commentId },
    actorId: session.userId,
    // Safe to call twice — a retried request will not double-notify.
    dedupeKey: `commentReply:${commentId}:${threadOwnerId}`,
  });

  return Response.json({ ok: true });
}
