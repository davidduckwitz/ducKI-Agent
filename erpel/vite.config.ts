import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  server: {
    port: 5188,
    strictPort: true,
    host: true,
    proxy: { "/erpel-api": "http://127.0.0.1:3098" },
  },
  build: { outDir: "dist", sourcemap: true },
});
