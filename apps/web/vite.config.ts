import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Match dev.js's IPv4 loopback target: localhost can resolve to ::1 while the
// backend listens on IPv4, causing HTTP failures and WebSocket "socket hang up".
const proxyTarget = process.env["VITE_API_PROXY_TARGET"] ?? "http://127.0.0.1:3001";

// The built UI calls /api and /socket.io relative to its own origin (see
// backendUrl.ts). Both the dev server AND the preview server (which serves the
// production build) must proxy those to the agent, otherwise the local Web-UI
// starts but cannot reach the agent.
const proxy = {
  "/api": { target: proxyTarget, changeOrigin: true, ws: true },
  "/socket.io": { target: proxyTarget, changeOrigin: true, ws: true },
  "/ws": { target: proxyTarget, changeOrigin: true, ws: true },
};

const port = process.env["VITE_PORT"] ? parseInt(process.env["VITE_PORT"]) : 5173;

// Allow access via the Tailscale MagicDNS hostname (*.ts.net) in addition to localhost.
const allowedHosts = [".ts.net"];

// The preview server serves the production build for the local install. It binds
// to loopback by default so the local Web-UI is not exposed on the LAN; set
// VITE_PREVIEW_HOST (e.g. 0.0.0.0) to opt into network/Tailscale access.
const previewHost = process.env["VITE_PREVIEW_HOST"] ?? "127.0.0.1";

// Optional native TLS (e.g. certs from `tailscale cert <name>.ts.net`). Note: a Vite port speaks
// EITHER http OR https. For both at once use `tailscale serve` (HTTPS :443 -> http :5173).
const certFile = process.env["VITE_HTTPS_CERT"];
const keyFile = process.env["VITE_HTTPS_KEY"];
const https = certFile && keyFile ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) } : undefined;

// Desktop build (`--mode desktop`): Monaco's TS worker ships as an on-demand component (see
// src/lib/monacoSetup.ts). Monaco's own unused fallback `new Worker(new URL("ts.worker.js", ...))`
// and the dead `?worker` import would still make Vite emit the ~7MB worker, so both are cut out.
function dropMonacoTsWorker(): Plugin {
  return {
    name: "drop-monaco-ts-worker",
    enforce: "pre",
    // Vite emits a `?worker` import's file while resolving it, before dead-code removal - so the
    // (statically dead) import in monacoSetup.ts must resolve to a stub instead.
    resolveId(source) {
      return source.includes("language/typescript/ts.worker") && source.includes("?worker") ? "\0monaco-ts-worker-stub" : undefined;
    },
    load(id) {
      return id === "\0monaco-ts-worker-stub"
        ? 'export default class { constructor() { throw new Error("TS worker comes from the monaco-ts component"); } }'
        : undefined;
    },
    transform(code, id) {
      if (!/monaco-editor[\\/]esm[\\/]vs[\\/]language[\\/]typescript[\\/]workerManager\.js$/.test(id)) return undefined;
      const out = code.replace(
        /new Worker\(new URL\(['"]ts\.worker\.js['"], import\.meta\.url\)[^)]*\)/,
        '(() => { throw new Error("TS worker comes from the monaco-ts component"); })()'
      );
      if (out === code) this.error("monaco workerManager.js changed - update dropMonacoTsWorker");
      return out;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "desktop" ? [dropMonacoTsWorker()] : [])],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  server: {
    host: true,
    https,
    allowedHosts,
    port,
    strictPort: false,
    proxy,
  },
  preview: {
    host: previewHost,
    https,
    allowedHosts,
    port,
    strictPort: false,
    proxy,
  },
  build: {
    outDir: "dist",
    // Maps were ~45MB of the desktop installer; opt in with DUCKI_SOURCEMAP=1 when debugging a build.
    sourcemap: process.env["DUCKI_SOURCEMAP"] === "1",
  },
}));
