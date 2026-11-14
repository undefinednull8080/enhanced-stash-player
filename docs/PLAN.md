# Enhanced Stash Player: build spec

Source of truth for v0.1.0. The decisions (Q1–Q29) are in the shared plan doc; this file restates
everything an implementer needs. Anything not stated here: choose the simplest option and note it.

## Product

A Stash (stashapp) UI plugin, plugin id `enhanced-stash-player`, that adds to the scene page player:

1. **Starts At** — a per-scene start time. Playback jumps there automatically; a "Skip intro" button
   jumps there manually.
2. **Watch trends** — a mostly transparent graph above the seek bar showing how much each moment of
   the scene has been played (YouTube "most replayed" style).

Constraints: JavaScript + CSS only. **No Python, no backend, no `exec` in the manifest, no build step
for the plugin itself, no runtime dependencies.** Requires Stash v0.31.0+ (scene custom fields).
License: The Unlicense (already in repo). Do not copy code from mrx-31415/stash-auto-seek (AGPL).

## Repo layout (target)

```
enhanced-stash-player/            # the plugin folder; zipped as-is (files at zip root)
  enhanced-stash-player.yml       # the ONLY .yml in this folder
  esp-core.js                     # pure helpers, no DOM; also loadable by node tests
  esp-starts-at.js
  esp-tracker.js                  # counting, buffering, lock, saving
  esp-graph.js
  esp-main.js                     # wiring: location events, player attach, settings, version check
  enhanced-stash-player.css
scripts/build.mjs                 # node, no deps: zip + index.yml per channel
tests/*.test.mjs                  # node --test, no deps
tests/e2e/                        # Playwright against Docker Stash
docker-compose.yml                # dev + e2e Stash, plugin folder mounted
.github/workflows/ci.yml, pages.yml
README.md, docs/PLAN.md
```

Files share one namespace: `window.ESP = window.ESP || {}`; each file wraps itself in an IIFE and
attaches its exports. Manifest `ui.javascript` lists them in order: core, starts-at, tracker, graph,
main. `esp-core.js` must also work under node: end with
`if (typeof module !== "undefined") module.exports = ESP.core;` (or equivalent that tests can load
via `createRequire`/`vm`). Keep other modules' pure logic in `ESP.core` so it is unit-testable.

## Stash facts (verified against stash source)

- Manifest parsed strictly (`pkg/plugin/config.go:414`): unknown keys break loading. Allowed
  top-level: `name, description, version, url, ui, settings` (also exec/interface/tasks/hooks — not
  used). `ui`: `javascript, css, requires, assets, csp`. Setting keys: `displayName, description,
  type` only — NO `default`. Types: `STRING`, `NUMBER`, `BOOLEAN`. Unset settings arrive as
  `undefined` in JS; JS applies defaults.
- Plugin id = manifest filename without `.yml`. Stash parses every `.yml` in the plugins dir.
- Read settings: GraphQL `query { configuration { plugins(include: ["enhanced-stash-player"]) } }`
  → `data.configuration.plugins["enhanced-stash-player"]`.
- `window.PluginApi`: `PluginApi.Event.addEventListener("stash:location", e =>
  e.detail.data.location.pathname)`; `PluginApi.utils.InteractiveUtils.getPlayer()` returns the
  video.js player (exists in v0.31.0, `hooks/Interactive/utils.ts:48`). Scene page path:
  `/scenes/<id>`. Only the scene page player is video.js; wall/hover/marker previews are plain
  `<video>` and must be ignored.
- Scene custom fields (v0.31.0+): `sceneUpdate(input: {id, custom_fields: {partial: {k: v}}})`,
  remove with `custom_fields: {remove: ["k"]}`. Values must be scalars (number/string/bool); arrays
  and objects are rejected. Key max 64 chars. Read with `findScene(id) { custom_fields }`.
- Every `sceneUpdate` bumps the scene's `updated_at` and fires other plugins' `Scene.Update.Post`
  hooks. Hence: save rarely, never save when there is nothing new.
- Stash's scene edit form sends `custom_fields: {full: <map as loaded>}` which replaces all fields.
  Accepted limitation (documented); mitigated by Q29 below.
- GraphQL endpoint `/graphql`, same-origin, cookies auth (`credentials: "same-origin"`).
- Server version: `query { version { version } }` (e.g. `v0.31.0`).

## Starts At

- Field `esp_start_at` (number, seconds).
- Flag button in the video.js control bar (before fullscreen): click saves `currentTime` via
  partial update; toast "Start set to 1:23" with Undo (restores previous value or removes).
  Long-press (≥600 ms) or right-click clears it (toast with Undo).
- Auto-jump: on the player's first `playing` for a scene, if setting "Don't jump to Starts At" is not
  true, `esp_start_at` is set, `currentTime < 15`, `currentTime < esp_start_at`, and the viewer has
  not seeked themselves → seek to `max(0, esp_start_at - leadIn)`; toast "Skipped to 1:23" + Undo.
  Resume points past the start win (that is the `currentTime` check). Our own seeks are flagged so
  the `seeking` listener does not treat them as the viewer's.
- Applies on queue advance (each new `/scenes/<id>` location / new source) the same way.
- "Skip intro" button overlaid on the video, shown only while `esp_start_at` is set and
  `currentTime < esp_start_at - 2` and no auto-jump happened (or it was undone); click jumps to the
  same target.
- Seek through the video.js player API (`player.currentTime(t)`), not the bare element.
- Time jumped over by our seeks is never counted.

## Watch counting

- 200 buckets per scene; bucket i covers `[i*d/200, (i+1)*d/200)` of duration d.
- On each `timeupdate` while playing and `playbackRate === 1`: step = currentTime − lastTime; count
  only if `0 < step <= 1.5` (larger = seek). Add the played fraction of each bucket touched, in
  **tenths** (half a bucket = 5 tenths… i.e. value units are 0.1 plays). Rewinds that replay add
  again.
- Format: `"v1:" + base64(200 × uint16 little-endian)`; saturate at 65535. Decode tolerates
  missing/invalid (→ zeros).
- Field per browser: `esp_watch_<browserId>`, browserId = 8 random [a-z0-9] chars stored in
  localStorage `esp:browser-id`.
- In-memory pending counts per tab; copied every 5 s to localStorage
  `esp:pending:<sceneId>:<tabId>` with a heartbeat timestamp. On load, pending entries from tabs whose
  heartbeat is older than 15 s are adopted and saved.
- Save triggers (no timer): video `pause`, `ended`, scene change / leaving (`stash:location`), and
  `visibilitychange` → hidden. Skip if no pending counts. Respect setting "Don't record watching"
  (then: no counting, no saving).
- Save procedure (tabs of one browser serialize via a localStorage lock; Web Locks unavailable on
  plain http):
  1. Acquire `esp:lock` = `{owner: tabId, until: now+5000}`: if absent/expired, write it, wait
     50 ms, re-read; if still ours, we hold it; else retry after 250 ms (give up after ~5 s and keep
     counts pending).
  2. Read own field via `findScene { custom_fields }`.
  3. Base = bucket-wise max(server value, last value this browser wrote — localStorage
     `esp:last:<sceneId>`), **unless** the server field is absent and we had written it before → the
     user deleted it: base = zeros and drop `esp:last` (Q29).
  4. New = base + pending; write via partial update; store New in `esp:last:<sceneId>`; clear
     pending; release lock.
- `pagehide`: no time to read: `fetch(..., {keepalive: true})` writing `esp:last + pending`; record
  `esp:inflight:<sceneId>` = expected value; on next load, if the server field ≠ expected, re-apply.
  Keep pending in localStorage until confirmed.

## Graph

- Data: every `esp_watch_*` field on the scene, decoded and summed bucket-wise; smoothed (moving
  average over 5 buckets); scaled so the max is full height. Shown whenever any bucket > 0.
- Rendering: an SVG filled area, 36 px tall, white at ~25% opacity, positioned directly above the
  video.js seek bar and horizontally aligned with `.vjs-progress-holder` (ResizeObserver to keep
  aligned). Small tick at `esp_start_at`. Visible only while the control bar is visible (follow
  video.js `vjs-user-inactive` / `vjs-user-active` and paused state). `pointer-events: none` so it
  never blocks seeking. Redraw after this browser's saves.
- Setting "Hide the watch graph".

## Settings (manifest; all opt-out, defaults applied in JS)

| key | type | displayName | default |
| --- | --- | --- | --- |
| `disableAutoJump` | BOOLEAN | Don't jump to Starts At | false |
| `leadIn` | NUMBER | Lead-in (seconds) | 0 (clamp 0–60) |
| `hideGraph` | BOOLEAN | Hide the watch graph | false |
| `disableTracking` | BOOLEAN | Don't record watching | false |

Version check: once per page load; if server version < v0.31.0, one toast/console warning, and the
plugin does nothing else.

## Packaging and release

- `scripts/build.mjs` (node ≥ 20, no deps — write a minimal zip writer using `zlib.deflateRawSync`
  and CRC32, or store-only): zips the contents of `enhanced-stash-player/` (files at zip root),
  computes sha256 (lowercase hex), writes `<out>/<channel>/enhanced-stash-player.zip` and
  `<out>/<channel>/index.yml`:
  ```yaml
  - id: enhanced-stash-player
    name: Enhanced Stash Player
    metadata:
      description: "<quoted; JSON-quote to survive colons>"
    version: <version>
    date: "YYYY-MM-DD HH:MM:SS"   # UTC, from the commit time
    path: enhanced-stash-player.zip
    sha256: <hex>
    requires: []
  ```
  The zipped manifest's `version:` is rewritten to match the index version.
- Stash offers an update only when `date` is newer; `version` is display only.
- Channels: `stable` from the newest `v*` tag (version = tag without `v`), `dev` from `main`
  (version = `<yml version>-dev.<shortsha>`). The Pages workflow builds **both** every deploy
  (checkout with `fetch-depth: 0`, `git worktree`/`git archive` the tag for stable) so one never
  deletes the other. Pages via Actions: `actions/upload-pages-artifact` + `actions/deploy-pages`,
  permissions `pages: write, id-token: write`. Triggers: push to `main`, push of `v*` tags,
  `workflow_dispatch`. If no tag exists yet, publish dev only.
- Source URLs: `https://undefinednull8080.github.io/enhanced-stash-player/stable/index.yml` and
  `.../dev/index.yml`.
- `ci.yml`: on PR and push: `node --test`, a manifest check (only allowed keys, exactly one .yml in
  the plugin folder, every `ui.javascript`/`ui.css` file exists), and a build dry run.

## Dev and tests

- `docker-compose.yml`: `stashapp/stash:v0.31.1` (pin), port 9999, plugin folder mounted read-only
  at `/root/.stash/plugins/enhanced-stash-player`, a `tests/e2e/media` folder mounted as the library.
  Generate a short synthetic clip with ffmpeg (inside the stash container, which ships ffmpeg) in
  e2e setup rather than committing media.
- Unit tests (`node --test`): format encode/decode, bucket accumulation (incl. boundaries, seeks,
  saturation), summing fields, smoothing/scaling, base-merge rule (Q29), lock algorithm with a fake
  storage + fake clock, settings defaults, version comparison, index.yml generation.
- E2E (Playwright, `tests/e2e/`): set Starts At via the flag and see `esp_start_at` saved; reload and
  play → jumps; play a few seconds, pause → `esp_watch_*` field written; two pages on the same scene
  both counting → counts add up (nothing lost); graph element present after data exists.

## Known limits (document in README)

Edit-form save overwrites `esp_` fields loaded earlier (this browser self-heals its own counts);
each save bumps `updated_at` and runs other plugins' update hooks; each private window leaves one
field; other devices see counts only after a save; replaced files with a different cut misalign.
