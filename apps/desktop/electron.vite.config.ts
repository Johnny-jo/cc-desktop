import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@claude-desktop/shared"] })],
    build: {
      outDir: "out/main",
      lib: {
        entry: resolve("electron/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@claude-desktop/shared"] })],
    build: {
      outDir: "out/preload",
      lib: {
        entry: resolve("electron/preload/index.ts"),
      },
    },
  },
  renderer: {
    root: ".",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve("index.html"),
      },
    },
  },
});
