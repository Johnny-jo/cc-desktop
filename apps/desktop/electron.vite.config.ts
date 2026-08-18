import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@claude-desktop/shared"] })],
    build: {
      outDir: "out/main",
      rollupOptions: {
        input: {
          index: resolve("electron/main/index.ts"),
          "mod-host-worker": resolve("electron/main/mod-host-worker.ts"),
        },
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
    server: {
      // Windows Hyper-V/WSL/NAT often reserves 5141–5240; Vite's 5173 sits in that
      // range and bind fails with EACCES on ::1. Force IPv4 + a free port.
      host: "127.0.0.1",
      port: 5273,
      strictPort: false,
    },
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: resolve("index.html"),
      },
    },
  },
});
