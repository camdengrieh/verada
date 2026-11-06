import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src/", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@verada\/ui\/(components|lib|hooks)\/(.*)$/, replacement: `${src}$1/$2` }],
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"] },
});
