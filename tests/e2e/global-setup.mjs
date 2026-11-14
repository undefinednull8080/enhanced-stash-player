import { up } from "./stash.mjs";

export default async function globalSetup() {
  await up();
}
