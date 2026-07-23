import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_PORT = process.env.DR_BACKEND_PORT ?? "3178";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.DR_FRONTEND_PORT ?? 5173),
    proxy: {
      "/api": {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
