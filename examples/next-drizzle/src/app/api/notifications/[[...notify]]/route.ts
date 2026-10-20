import { notify } from "../../../../notify";

// Mounts the whole client-facing surface:
//   GET  /api/notifications          feed
//   GET  /api/notifications/count    unseen badge count
//   POST /api/notifications/seen     clear the badge
//   POST /api/notifications/read     mark specific items read
//   POST /api/notifications/read-all
//   POST /api/notifications/cron     machine route, Bearer NOTIFY_CRON_SECRET
export const { GET, POST } = notify.handler;
