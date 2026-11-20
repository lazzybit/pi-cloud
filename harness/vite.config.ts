import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  plugins: [
    solid({
      ssr: true,
      start: { middleware: "./src/web/middleware.ts", nodeServer: true },
      serverFunctions: true,
    }),
  ],
});
