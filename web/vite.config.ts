import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const engine = process.env.EEVEE_ENGINE ?? "http://127.0.0.1:19190";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/ui/",
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  // The dependency scan misses this one (reached through `@shared`), so the first visit would optimize it and
  // reload the page, which can swallow a one-time sign-in code.
  optimizeDeps: { include: ["@earendil-works/pi-schema"] },
  build: {
    chunkSizeWarningLimit: 1000,
    outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": { target: engine, changeOrigin: true, ws: true } },
  },
});
