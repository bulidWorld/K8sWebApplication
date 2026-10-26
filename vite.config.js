import { defineConfig } from "vite";
export default defineConfig({
  // server/dev.js loads .env.local; avoid Vite also reading production .env.
  envDir: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": `http://${process.env.HOST || "127.0.0.1"}:${process.env.PORT || "3000"}` },
  },
});
