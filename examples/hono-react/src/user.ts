// Stand-in for your auth: ?user=dana acts as dana. Real apps rely on their session cookie.
export const currentUser = new URLSearchParams(location.search).get("user") || "you";

export const asCurrentUser: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("x-demo-user", currentUser);
  return fetch(input, { ...init, headers });
};
