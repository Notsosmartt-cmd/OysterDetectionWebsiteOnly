import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 8080,
    // Cross-origin isolation lets the WASM backend use multiple threads (SharedArrayBuffer)
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    watch: {
      ignored: [
        // Always use recursive glob patterns to match everything under these folders
        "**/ModelResearch/**",
        "**/ForHamid/**",
      ]
    }
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  base: "/",
  build: {
    chunkSizeWarningLimit: 2000,
    // Vite's default target includes Safari 13, which has no BigInt literals (1n). The video remuxing
    // library uses them, so the minimum is Safari 14 (still older than anything the app needs anyway).
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
  },
  optimizeDeps: {
    esbuildOptions: { target: "es2020" }, // same reason, for the dev server's dependency pre-bundling
  },
});
