import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const API_TARGET = process.env.VITE_API_TARGET || "http://localhost:8787";

const proxyOpts = {
  target: API_TARGET,
  changeOrigin: true,
  secure: false,
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5175,
    proxy: {
      "/v1": proxyOpts,
      "/health": proxyOpts,
    },
  },
});
