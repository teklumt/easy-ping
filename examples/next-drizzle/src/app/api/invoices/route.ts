import { notify } from "../../../notify";
import { getSession } from "../../../session";

// A system event: there is no actor.
export async function POST(request: Request) {
  const session = await getSession(request);
  if (!session) return new Response(null, { status: 401 });

  const result = await notify.send("invoicePaid", {
    to: session.userId,
    payload: { amount: 4900 },
  });

  return Response.json(result);
}
