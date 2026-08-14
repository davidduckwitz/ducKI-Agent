import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const proxyTarget = process.env["VITE_API_PROXY_TARGET"] ?? "http://localhost:3001";

// The built UI calls /api and /socket.io relative to its own origin (see
// backendUrl.ts). Both the dev server AND the preview server (which serves the
// production build) must proxy those to the agent, otherwise the local Web-UI
// starts but cannot reach the agent.
const proxy = {
  "/api": { target: proxyTarget, changeOrigin: true, ws: true },
  "/socket.io": { target: proxyTarget, changeOrigin: true, ws: true },
};

const port = process.env["VITE_PORT"] ? parseInt(process.env["VITE_PORT"]) : 5173;

// Allow access via the Tailscale MagicDNS hostname (*.ts.net) in addition to localhost.
const allowedHosts = [".ts.net"];

// The preview server serves the production build for the local install. It binds
// to loopback by default so the local Web-UI is not exposed on the LAN; set
// VITE_PREVIEW_HOST (e.g. 0.0.0.0) to opt into network/Tailscale access.
const previewHost = process.env["VITE_PREVIEW_HOST"] ?? "127.0.0.1";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  server: {
    host: true,
    allowedHosts,
    port,
    strictPort: false,
    proxy,
  },
  preview: {
    host: previewHost,
    allowedHosts,
    port,
    strictPort: false,
    proxy,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
