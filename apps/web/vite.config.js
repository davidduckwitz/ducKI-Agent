import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(dirname, "src"),
        },
    },
    server: {
        host: true,
        // Allow access via the Tailscale MagicDNS hostname (*.ts.net) in addition to localhost.
        allowedHosts: [".ts.net"],
        port: process.env["VITE_PORT"] ? parseInt(process.env["VITE_PORT"]) : 5173,
        strictPort: false,
        proxy: {
            "/api": {
                target: process.env["VITE_API_PROXY_TARGET"] ?? "http://localhost:3001",
                changeOrigin: true,
                ws: true,
            },
            "/socket.io": {
                target: process.env["VITE_API_PROXY_TARGET"] ?? "http://localhost:3001",
                changeOrigin: true,
                ws: true,
            },
        },
    },
    build: {
        outDir: "dist",
        sourcemap: true,
    },
});
