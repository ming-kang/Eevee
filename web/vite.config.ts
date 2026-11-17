import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const engine = process.env.EEVEE_ENGINE ?? "http://127.0.0.1:19190";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/ui/",
  plugins: [vue()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": { target: engine, changeOrigin: true } },
  },
});
