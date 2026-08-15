import { defineConfig, devices } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number.parseInt(process.env.PLAYWRIGHT_PORT ?? "3100", 10);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;
const hostname = new URL(baseURL).hostname;
const artifactRoot = process.env.PLAYWRIGHT_ARTIFACT_DIR
  ?? join(tmpdir(), "notique-playwright");

if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  throw new Error(
    `Refusing to run write-guarded E2E tests against non-local host: ${hostname}`,
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  outputDir: join(artifactRoot, "results"),
  reporter: [
    ["line"],
    ["html", { outputFolder: join(artifactRoot, "report"), open: "never" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: `npm run dev -- --port ${port}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
