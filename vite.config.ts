import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  root: "web",
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [solid()],
});
