import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "ponder:schema": fileURLToPath(new URL("./ponder.schema.ts", import.meta.url)),
      "ponder:api": fileURLToPath(new URL("./test/support/ponder-api.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
