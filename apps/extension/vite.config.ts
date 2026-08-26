import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        offscreen: resolve(__dirname, "src/offscreen/index.ts"),
        popup: resolve(__dirname, "src/popup/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        format: "es",
      },
    },
    target: "es2020",
  },
});
