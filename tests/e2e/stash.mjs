// Helpers for the e2e Stash in ../../docker-compose.yml: start it, configure it, seed media, talk GraphQL.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, "..", "..");
export const baseURL = process.env.ESP_STASH_URL || "http://localhost:9999";
export const core = createRequire(import.meta.url)("../../enhanced-stash-player/esp-core.js");

const CLIP = "esp-test.webm";
export const CLIP_SECONDS = 120;

// A pre-written config.yml skips Stash's first-run wizard.
const CONFIG = `stash:
  - path: /data/
database: /root/.stash/stash-go.sqlite
generated: /generated
cache: /cache
blobs_storage: DATABASE
`;

function compose(args, options = {}) {
  return execFileSync("docker", ["compose", ...args], { cwd: repoRoot, encoding: "utf8", ...options });
}

export async function gql(query, variables = {}) {
  const res = await fetch(baseURL + "/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, what, timeout = 60000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await sleep(500);
  }
}

export async function up() {
  const config = join(repoRoot, "tests/e2e/.stash/config");
  mkdirSync(config, { recursive: true });
  mkdirSync(join(repoRoot, "tests/e2e/media"), { recursive: true });
  if (!existsSync(join(config, "config.yml"))) writeFileSync(join(config, "config.yml"), CONFIG);

  compose(["up", "-d", "--wait"], { stdio: "inherit" });
  await waitFor(async () => (await gql("{ systemStatus { status } }")).systemStatus.status === "OK", "Stash");

  if (!existsSync(join(repoRoot, "tests/e2e/media", CLIP))) {
    // testsrc + a tone, VP8/Opus: headless Chromium plays it directly (no H.264 there).
    compose(["exec", "-T", "stash", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc=duration=${CLIP_SECONDS}:size=320x240:rate=25`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${CLIP_SECONDS}`,
      "-c:v", "libvpx", "-b:v", "300k", "-deadline", "realtime", "-cpu-used", "8",
      "-c:a", "libopus", "-shortest", "/data/" + CLIP]);
  }

  // Stash's own resume points would start playback past Starts At and mask the auto-jump.
  await gql('mutation { configureUISetting(key: "trackActivity", value: false) }');
  // Hide the Release Notes dialog, which would cover the player.
  await gql('mutation { configureUISetting(key: "lastNoteSeen", value: 99999999) }');
  await gql("mutation { metadataScan(input: {}) }");
  await waitFor(async () => !(await gql("{ jobQueue { id } }")).jobQueue, "scan");
  await waitFor(sceneId, "scanned scene");
  await gql("mutation { reloadPlugins }");
  const { plugins } = await gql("{ plugins { id enabled } }");
  const ours = plugins.find((p) => p.id === core.PLUGIN_ID);
  if (!ours || !ours.enabled) throw new Error("plugin " + core.PLUGIN_ID + " is not loaded/enabled");
}

export function down() {
  compose(["down"], { stdio: "inherit" });
}

export async function sceneId() {
  const data = await gql(
    "query($f: SceneFilterType) { findScenes(scene_filter: $f) { scenes { id } } }",
    { f: { path: { value: CLIP, modifier: "INCLUDES" } } }
  );
  const scene = data.findScenes.scenes[0];
  return scene ? scene.id : null;
}

export async function customFields(id) {
  return (await gql("query($id: ID!) { findScene(id: $id) { custom_fields } }", { id })).findScene.custom_fields;
}

// Removes every esp_ field and the resume point, so each test starts clean.
export async function resetScene(id) {
  const keys = Object.keys(await customFields(id)).filter((k) => k.startsWith("esp_"));
  if (keys.length) {
    await gql("mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }", {
      input: { id, custom_fields: { remove: keys } },
    });
  }
  await gql("mutation($id: ID!) { sceneResetActivity(id: $id, reset_resume: true, reset_duration: true) }", { id });
}

export async function setFields(id, partial) {
  await gql("mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }", {
    input: { id, custom_fields: { partial } },
  });
}

export function watchFields(fields) {
  return Object.keys(fields).filter(core.isWatchField);
}

// Total tenths in buckets [from, to) of the decoded sum of all watch fields.
export function tenthsIn(fields, fromSec, toSec, duration = CLIP_SECONDS) {
  const sums = core.sumWatchFields(fields);
  const a = Math.floor((fromSec / duration) * core.BUCKETS);
  const b = Math.ceil((toSec / duration) * core.BUCKETS);
  let total = 0;
  for (let i = a; i < b; i++) total += sums[i];
  return total;
}

// Tenths that `seconds` of playback add: each second covers BUCKETS/duration buckets, 10 tenths each.
export function expectedTenths(seconds, duration = CLIP_SECONDS) {
  return (seconds * core.BUCKETS * 10) / duration;
}
