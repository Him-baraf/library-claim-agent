import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "node:path";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react(), ...(env.DEV_HTTPS === "true" ? [basicSsl()] : [])],
    server: {
      watch: {
        ignored: [
          "**/data/**",
          "**/dist/**",
          `${path.resolve(env.DATA_DIR || "./data")}/**`,
        ],
      },
      port: 5173,
      proxy: {
        "/api": { target: "http://127.0.0.1:8787", xfwd: true },
        "/evidence": { target: "http://127.0.0.1:8787", xfwd: true },
      },
    },
    build: { outDir: "dist" },
  };
});
