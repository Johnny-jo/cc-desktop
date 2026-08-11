import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["electron/main/**/*.test.ts", "src/**/*.test.ts"],
  },
});
