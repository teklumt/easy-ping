import { defineConfig } from "tsup";

// `clean` lives in the build script, not here: tsup runs array configs in
// parallel, so one config's clean races the other's output and silently
// deletes it (react.d.ts vanished exactly this way).
const shared = {
  format: ["esm", "cjs"] as const,
  target: "node20" as const,
  dts: true,
  treeshake: true,
  sourcemap: true,
};

export default defineConfig([
  {
    ...shared,
    entry: {
      index: "src/index.ts",
      client: "src/client/index.ts",
      browser: "src/browser/index.ts",
      sw: "src/sw/index.ts",
      node: "src/node/index.ts",
      "adapters/drizzle": "src/adapters/drizzle/index.ts",
      "adapters/mongodb": "src/adapters/mongodb/index.ts",
      "adapters/postgres": "src/adapters/postgres/index.ts",
      "adapters/mysql": "src/adapters/mysql/index.ts",
      "adapters/sqlite": "src/adapters/sqlite/index.ts",
      schema: "src/schema/index.ts",
      testing: "src/testing/index.ts",
      "providers/resend": "src/providers/resend/index.ts",
      "providers/web-push": "src/providers/web-push/index.ts",
      "plugins/preferences": "src/plugins/preferences/index.ts",
      "plugins/digests": "src/plugins/digests/index.ts",
      "plugins/push": "src/plugins/push/index.ts",
      "plugins/telegram": "src/plugins/telegram/index.ts",
      "providers/telegram": "src/providers/telegram/index.ts",
      "plugins/mobile-push": "src/plugins/mobile-push/index.ts",
      "providers/expo-push": "src/providers/expo-push/index.ts",
      "plugins/preferences-client": "src/plugins/preferences/client.ts",
    },
  },
  {
    ...shared,
    entry: {
      react: "src/react/index.ts",
      "plugins/preferences-react": "src/plugins/preferences/react.ts",
    },
    external: ["react"],
    // Its own config so the directive lands only on the React entry — putting
    // "use client" on the server entries would be actively wrong.
    banner: { js: '"use client";' },
    // Rollup's treeshake pass strips module-level directives and the banner
    // with them, leaving the hook unusable in a Next.js server component tree.
    // Nothing to treeshake in a single hook anyway.
    treeshake: false,
  },
  {
    ...shared,
    entry: { "react-native": "src/react-native/index.ts" },
    // Both come from the app's own bundle; react-native is not even installable here.
    external: ["react", "react-native"],
    treeshake: false,
  },
]);
