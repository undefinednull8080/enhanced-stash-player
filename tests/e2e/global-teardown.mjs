import { down } from "./stash.mjs";

// ESP_E2E_KEEP=1 leaves Stash running (handy while writing tests).
export default async function globalTeardown() {
  if (process.env.ESP_E2E_KEEP !== "1") down();
}
