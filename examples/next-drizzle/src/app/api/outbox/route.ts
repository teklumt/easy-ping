import { eq } from "drizzle-orm";
import { db, schema } from "../../../db";
import { emailsTo } from "../../../outbox";
import { getSession } from "../../../session";

// What the outbox provider received for the signed-in user's address.
export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) return new Response(null, { status: 401 });

  const [user] = await db.select().from(schema.user).where(eq(schema.user.id, session.userId));
  return Response.json({ emails: user ? emailsTo(user.email) : [] });
}
