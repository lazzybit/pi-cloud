import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  testMatch: "*.spec.ts",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: process.env.PI_E2E_ORIGIN,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
