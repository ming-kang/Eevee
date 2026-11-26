import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const engineTarget = process.env.EEVEE_ENGINE_URL ?? "http://127.0.0.1:4173";

const API_PREFIXES = [
  "/health",
  "/auth",
  "/projects",
  "/providers",
  "/models",
  "/mcp",
  "/settings",
  "/config",
  "/shutdown",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@eevee/protocol": resolve(here, "../../packages/protocol/src/index.ts"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [
        prefix,
        {
          target: engineTarget,
          changeOrigin: true,
          headers: { origin: engineTarget },
        },
      ]),
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
