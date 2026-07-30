// vite.config.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "file:///M:/projekte/ducki-node/node_modules/.pnpm/vite@5.4.21_@types+node@22.20.1/node_modules/vite/dist/node/index.js";
import react from "file:///M:/projekte/ducki-node/node_modules/.pnpm/@vitejs+plugin-react@4.7.0_vite@5.4.21_@types+node@22.20.1_/node_modules/@vitejs/plugin-react/dist/index.js";
var __vite_injected_original_import_meta_url = "file:///M:/projekte/ducki-node/apps/web/vite.config.js";
var dirname = path.dirname(fileURLToPath(__vite_injected_original_import_meta_url));
var vite_config_default = defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src")
    }
  },
  server: {
    port: process.env["VITE_PORT"] ? parseInt(process.env["VITE_PORT"]) : 5173,
    strictPort: false,
    proxy: {
      "/api": {
        target: process.env["VITE_API_PROXY_TARGET"] ?? "http://127.0.0.1:3001",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJNOlxcXFxwcm9qZWt0ZVxcXFxkdWNraS1ub2RlXFxcXGFwcHNcXFxcd2ViXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJNOlxcXFxwcm9qZWt0ZVxcXFxkdWNraS1ub2RlXFxcXGFwcHNcXFxcd2ViXFxcXHZpdGUuY29uZmlnLmpzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9NOi9wcm9qZWt0ZS9kdWNraS1ub2RlL2FwcHMvd2ViL3ZpdGUuY29uZmlnLmpzXCI7aW1wb3J0IHBhdGggZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSBcInZpdGVcIjtcbmltcG9ydCByZWFjdCBmcm9tIFwiQHZpdGVqcy9wbHVnaW4tcmVhY3RcIjtcbmNvbnN0IGRpcm5hbWUgPSBwYXRoLmRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gICAgcGx1Z2luczogW3JlYWN0KCldLFxuICAgIHJlc29sdmU6IHtcbiAgICAgICAgYWxpYXM6IHtcbiAgICAgICAgICAgIFwiQFwiOiBwYXRoLnJlc29sdmUoZGlybmFtZSwgXCJzcmNcIiksXG4gICAgICAgIH0sXG4gICAgfSxcbiAgICBzZXJ2ZXI6IHtcbiAgICAgICAgcG9ydDogcHJvY2Vzcy5lbnZbXCJWSVRFX1BPUlRcIl0gPyBwYXJzZUludChwcm9jZXNzLmVudltcIlZJVEVfUE9SVFwiXSkgOiA1MTczLFxuICAgICAgICBzdHJpY3RQb3J0OiBmYWxzZSxcbiAgICAgICAgcHJveHk6IHtcbiAgICAgICAgICAgIFwiL2FwaVwiOiB7XG4gICAgICAgICAgICAgICAgdGFyZ2V0OiBwcm9jZXNzLmVudltcIlZJVEVfQVBJX1BST1hZX1RBUkdFVFwiXSA/PyBcImh0dHA6Ly8xMjcuMC4wLjE6MzAwMVwiLFxuICAgICAgICAgICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgfSxcbiAgICBidWlsZDoge1xuICAgICAgICBvdXREaXI6IFwiZGlzdFwiLFxuICAgICAgICBzb3VyY2VtYXA6IHRydWUsXG4gICAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUF5UixPQUFPLFVBQVU7QUFDMVMsU0FBUyxxQkFBcUI7QUFDOUIsU0FBUyxvQkFBb0I7QUFDN0IsT0FBTyxXQUFXO0FBSDZKLElBQU0sMkNBQTJDO0FBSWhPLElBQU0sVUFBVSxLQUFLLFFBQVEsY0FBYyx3Q0FBZSxDQUFDO0FBQzNELElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQ3hCLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxFQUNqQixTQUFTO0FBQUEsSUFDTCxPQUFPO0FBQUEsTUFDSCxLQUFLLEtBQUssUUFBUSxTQUFTLEtBQUs7QUFBQSxJQUNwQztBQUFBLEVBQ0o7QUFBQSxFQUNBLFFBQVE7QUFBQSxJQUNKLE1BQU0sUUFBUSxJQUFJLFdBQVcsSUFBSSxTQUFTLFFBQVEsSUFBSSxXQUFXLENBQUMsSUFBSTtBQUFBLElBQ3RFLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxNQUNILFFBQVE7QUFBQSxRQUNKLFFBQVEsUUFBUSxJQUFJLHVCQUF1QixLQUFLO0FBQUEsUUFDaEQsY0FBYztBQUFBLE1BQ2xCO0FBQUEsSUFDSjtBQUFBLEVBQ0o7QUFBQSxFQUNBLE9BQU87QUFBQSxJQUNILFFBQVE7QUFBQSxJQUNSLFdBQVc7QUFBQSxFQUNmO0FBQ0osQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
