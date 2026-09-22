const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * For email templates built with template literals. Anything in a payload
 * that a user typed — a display name, a comment excerpt — goes through this
 * or the recipient gets that user's HTML delivered from your sending domain.
 */
export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
