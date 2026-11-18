import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiUrl = process.env.INCIDENTIQ_API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": apiUrl
    }
  }
});
