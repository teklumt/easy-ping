import { defineConfig } from "drizzle-kit";

try {
  process.loadEnvFile();
} catch {
  // No .env: DATABASE_URL comes from the environment.
}

export default defineConfig({
  dialect: "postgresql",
  // Your tables and easy-ping's core tables, then the push plugin's.
  schema: ["./src/db/schema.ts", "./src/db/easy-ping-plugins.ts"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
