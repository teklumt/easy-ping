import { PEOPLE } from "../../../session";

// The stand-in for your sign-in flow: sets the cookie getSession() reads, then goes home.
export function GET(request: Request) {
  const user = new URL(request.url).searchParams.get("user") ?? "";
  if (!PEOPLE.includes(user as (typeof PEOPLE)[number])) {
    return new Response("unknown user", { status: 400 });
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": `demo-user=${user}; Path=/; HttpOnly; SameSite=Lax`,
    },
  });
}
