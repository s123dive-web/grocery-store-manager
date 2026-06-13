import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served at the repo sub-path on GitHub Pages in production; at root during local dev.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/grocery-store-manager/" : "/",
  plugins: [react()],
  server: { port: 5173, open: true },
}));
