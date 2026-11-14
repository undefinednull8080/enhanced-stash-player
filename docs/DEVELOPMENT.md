# Development

You need Node.js 20+ for the tests and build, and Docker for a local Stash. The plugin itself has no
build step and no dependencies.

```sh
npm test          # unit tests (node --test, no dependencies)
npm run check     # manifest check: allowed keys only, one .yml, listed files exist
npm run build     # dev build into dist/dev/ (enhanced-stash-player.zip + index.yml)
npm run stash     # Stash v0.31.1 on http://localhost:9999, configured, with a test clip scanned
npm run e2e       # Playwright end-to-end tests against that Stash (starts and stops it)
docker compose down
```

Use `npm test` or plain `node --test`. On Node 22, `node --test tests/` fails, because Node reads a
directory argument as a module name.

## Local Stash

The plugin folder is mounted straight into the container. After an edit, reload the plugins
(**Settings → Plugins → Reload plugins**) and refresh the page.

- **State:** Stash state goes to `tests/e2e/.stash/` and media to `tests/e2e/media/`. Both are
  gitignored.
- **First run:** `npm run stash` writes a `config.yml` so Stash skips its setup wizard. It then makes
  a 120 s VP8/Opus test clip with the container's ffmpeg, scans it and reloads the plugins.

## End-to-end tests

`npm run e2e` does the whole run:

1. Installs `@playwright/test` and Chromium into `tests/e2e/`.
2. Starts Stash.
3. Runs `tests/e2e/player.spec.mjs`.
4. Runs `docker compose down`. Set `ESP_E2E_KEEP=1` to leave Stash running instead.

The tests cover:

- the plugin loading, with its `[ESP]` startup lines and no console errors
- Starts At: the flag saving `esp_start_at`, reload + play jumping, Undo and Skip intro
- counting: play + pause writing `esp_watch_<id>`, two tabs counting at once with nothing lost
- the graph and its tick
- saving on close: the `pagehide` keepalive save landing and being confirmed on the next load
- the settings

Playback is muted, and Chromium runs with `--autoplay-policy=no-user-gesture-required`. The clip is
WebM because Playwright's Chromium can't play H.264.

## Releasing

- **Dev:** every push to `main` publishes the dev channel to GitHub Pages.
- **Stable:** push a tag, for example `git tag v0.1.0 && git push origin v0.1.0`. The stable channel
  is built from the newest `v*` tag, and its version comes from the tag.

Both channels are rebuilt on every deploy, so publishing one never removes the other.

## How it works

- **Starts At:** stored in the scene custom field `esp_start_at`, as a number of seconds.
- **Counting:** each scene is split into 200 equal parts. While the scene plays at normal speed,
  played time is added to the parts it covers. A jump of more than 1.5 s counts as a seek and adds
  nothing. Jumps the plugin makes are never counted.
- **Storage:** each browser writes only its own field, `esp_watch_<id>`, where the id is a random
  8-character value kept in that browser. The value is `v1:` followed by base64 of 200 16-bit counts,
  in tenths of a play.
- **When it saves:**
  - on pause, after a 1 s wait so dragging the seek bar doesn't save
  - when the scene ends
  - when you leave the scene
  - when the tab goes to the background
  - when the tab closes, with a `keepalive` request

  Counts are also copied to localStorage every 5 s. Opening a scene saves anything a closed or
  crashed tab left behind. Nothing is saved when nothing new was played.
- **Several tabs:** tabs of one browser take turns through a lock in localStorage, so their counts
  add up instead of overwriting each other.
- **The graph:** sums every `esp_watch_*` field on the scene, smooths the result and scales it so the
  peak is full height.

## Layout

- `enhanced-stash-player/`: the plugin, shipped as-is.
  - `esp-core.js`: pure helpers, also loaded by the node tests.
  - `esp-main.js`: wiring; loads last.
  - `esp-starts-at.js`, `esp-tracker.js`, `esp-graph.js`: the features.
  - `enhanced-stash-player.css`: all styles.
- `scripts/`: `build.mjs` (zip + index.yml per channel) and `check-manifest.mjs`.
- `tests/`: unit tests.
- `tests/e2e/`: Playwright tests and the Docker Stash helpers.
- `docs/PLAN.md`: the spec. `docs/CONTRACT.md`: the interfaces between modules.
