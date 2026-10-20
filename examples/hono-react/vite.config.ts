import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3002,
    // The Hono server owns /api, including the long-lived GET /api/notifications/events stream.
    // changeOrigin stays off: easy-ping refuses a POST whose Origin differs from the Host it
    // received, and rewriting Host to 127.0.0.1:3003 would make every browser POST cross-origin.
    proxy: { "/api": { target: "http://127.0.0.1:3003", changeOrigin: false } },
  },
});
