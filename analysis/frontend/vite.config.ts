import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_PORT = process.env.DR_BACKEND_PORT ?? "3178";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.DR_FRONTEND_PORT ?? 5173),
    watch: {
      // Network shares on Windows often fail with native FS watchers.
      usePolling: true,
      interval: Number(process.env.DR_WATCH_INTERVAL ?? 1000),
      binaryInterval: Number(process.env.DR_WATCH_BINARY_INTERVAL ?? 1500),
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    },
    // Autoriser l'accès via un tunnel (ngrok & co) : Vite bloque par défaut
    // les Host inconnus pour éviter le DNS rebinding.
    allowedHosts: [".ngrok-free.app", ".ngrok.app", ".ngrok.dev", ".ngrok.io"],
    proxy: {
      "/api": {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
