import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The react-native entry imports a module that only exists inside an app.
    alias: {
      "react-native": new URL("./test/helpers/react-native-stub.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
