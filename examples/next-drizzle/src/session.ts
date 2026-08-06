/**
 * Stand-in for your auth library. With Better Auth this is:
 *
 *   getUserId: async (request) =>
 *     (await auth.api.getSession({ headers: request.headers }))?.user.id ?? null
 *
 * Returning null yields 401. Throwing yields 500 — deliberately distinct, so a
 * broken session store does not look like every user logging out at once.
 */
export async function getSession(request: Request): Promise<{ userId: string } | null> {
  const userId = request.headers.get("x-demo-user");
  return userId ? { userId } : null;
}
