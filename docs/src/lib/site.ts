/** The canonical origin. Every absolute URL the site emits (canonical, og:url, sitemap) starts here. */
export const SITE_URL = "https://easy-pings.com";
export const SITE_NAME = "easy-ping";
export const SITE_TAGLINE = "Self-hosted notifications for TypeScript";
export const SITE_DESCRIPTION =
  "Free, open-source notifications for TypeScript. In-app inbox, transactional email, web push, mobile push and Telegram, stored in your own Postgres, MySQL, SQLite or MongoDB. No SaaS, no per-notification bill.";
export const OG_IMAGE = `${SITE_URL}/og.png`;
export const AUTHOR = { name: "Teklu Moges", url: "https://github.com/teklumt" };
export const REPO_URL = "https://github.com/teklumt/easy-ping";
export const NPM_URL = "https://www.npmjs.com/package/easy-ping";

export const absolute = (path: string) => `${SITE_URL}${path === "/" ? "" : path}`;
