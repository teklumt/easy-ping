export const PEOPLE = ["you", "dana", "sam"] as const;

/**
 * Stand-in for your auth library: a cookie the page sets, defaulting to "you". With Better Auth:
 *
 *   (await auth.api.getSession({ headers: request.headers }))?.user.id ?? null
 *
 * Returning null yields 401. Throwing yields 500, so a broken session store does not look like
 * every user logging out at once.
 */
export async function getSession(request: Request): Promise<{ userId: string } | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const userId = /(?:^|;\s*)demo-user=([^;]+)/.exec(cookie)?.[1] ?? "you";
  return PEOPLE.includes(userId as (typeof PEOPLE)[number]) ? { userId } : null;
}
