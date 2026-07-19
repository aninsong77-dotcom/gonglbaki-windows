import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:5577" },
  },
  build: {
    outDir: "dist",
    // 이 앱은 Electron 36(크로미움 130대) 안에서만 구동 — pdf.js 4.x의
    // top-level await 때문에 기본 타깃(chrome87)으로는 빌드가 거부된다.
    target: "chrome120",
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
