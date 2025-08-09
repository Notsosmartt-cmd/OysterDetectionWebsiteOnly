import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 8080,
    watch: {
      ignored: [
        // Always use recursive glob patterns to match everything under these folders
        "**/ModelResearch/**",
        "**/ForHamid/**",
      ]
    }
  },
  base: "/",
  build: {
    chunkSizeWarningLimit: 2000
  }
});
