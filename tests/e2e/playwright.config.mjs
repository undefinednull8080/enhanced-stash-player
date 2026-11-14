import { defineConfig, devices } from "@playwright/test";
import { baseURL } from "./stash.mjs";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  // One Stash and one scene shared by every test, so run them one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [["list"]],
  globalSetup: "./global-setup.mjs",
  globalTeardown: "./global-teardown.mjs",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
