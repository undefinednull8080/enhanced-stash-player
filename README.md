# Enhanced Stash Player

A [Stash](https://github.com/stashapp/stash) UI plugin that adds two things to the scene player:

- **Starts At**: a start time for each scene. Playback jumps there automatically, and a "Skip intro"
  button jumps there by hand.
- **Watch trends**: a faint graph above the seek bar that shows how much each part of the scene has
  been played, like YouTube's "most replayed".

It is JavaScript and CSS only: no Python, no backend and no dependencies. It needs **Stash v0.31.0
or newer**, because it stores its data in scene custom fields.

## Install

1. In Stash, open **Settings → Plugins → Available Plugins → Add Source**.
2. Add one of these sources:
   - Stable: `https://undefinednull8080.github.io/enhanced-stash-player/stable/index.yml`
   - Dev (builds from `main`): `https://undefinednull8080.github.io/enhanced-stash-player/dev/index.yml`
3. Install **Enhanced Stash Player** from that source, then reload the browser tab.

To install by hand, copy the `enhanced-stash-player/` folder into your Stash `plugins` directory
and reload the plugins.

## Use

- **Set a start:** play to the right moment and click the flag button in the player's control bar.
  A toast confirms the time ("Start set to 1:23") and offers Undo.
- **Clear the start:** long-press or right-click the flag.
- **Auto-jump:** the plugin jumps only when all of these are true:
  - playback starts in the first 15 seconds
  - playback starts before the start time
  - you have not seeked yourself (a `?t=` link, a marker click or a seek-bar click counts as
    your own seek)

  A resume point past the start wins. A toast ("Skipped to 1:23") offers Undo. This also applies
  when a queue moves to the next scene.
- **Skip intro:** this button appears before the start time when no auto-jump happened (or it
  was undone). It comes back if you return to the intro.
- **Graph:** it appears above the seek bar once a scene has any watch data, and only while the
  controls are visible. It never blocks seeking. A small tick marks the start time.

## Settings

All settings are off by default. Change them in **Settings → Plugins → Enhanced Stash Player**, then
reload the page.

| Setting | Default | Effect |
| --- | --- | --- |
| Don't jump to Starts At | off | No automatic jump. Skip intro still works |
| Lead-in (seconds) | 0 | Jump this many seconds before the start (0–60) |
| Hide the watch graph | off | No graph |
| Don't record watching | off | No counting and no saving of watch data from this browser |

## How it works

- **Starts At** is saved in the scene custom field `esp_start_at`, as a number of seconds.
- **Watch counts:** each scene is split into 200 equal parts. While a scene plays at normal speed,
  the plugin adds each second of playback to the parts it covered. A jump of more than 1.5 s is a
  seek and is not counted. Our own jumps are never counted either.
- **Where counts are saved:** each browser keeps its counts in its own custom field,
  `esp_watch_<id>`. The id is a random 8-character value stored in that browser.
- **When counts are saved:** on pause (after a short wait, so a click on the seek bar does not
  save), on end, when leaving the scene and when the tab is hidden. When the tab closes, one last
  save goes out with `keepalive`. Opening a scene can also save once, to pick up counts that a
  closed or crashed tab left behind (or a closing save that did not arrive). Nothing is saved when
  nothing new was played.
- **Several tabs:** tabs of one browser take turns through a lock in localStorage, so counts from
  several tabs add up instead of overwriting each other.
- **The graph** sums every `esp_watch_*` field on the scene, smooths it and scales it.

## Known limits

- Saving the scene edit form writes back all custom fields as they were when the form loaded. That
  can overwrite `esp_` values changed in the meantime. This browser restores its own counts on its
  next save; a Starts At set after the form was opened may be lost.
- Every save bumps the scene's `updated_at` and runs other plugins' scene update hooks.
- Each private or incognito window gets a new browser id, so it leaves its own `esp_watch_*` field.
- Other devices see new counts only after this browser saves them.
- If a scene's file is replaced with a different cut, the old counts no longer line up.
- Settings are read once per page load.

## Development

You need Node.js 20+ for the tests and build, and Docker for a local Stash.

```sh
npm test          # unit tests (node --test, no dependencies)
npm run check     # manifest check: allowed keys only, one .yml, listed files exist
npm run build     # dev build into dist/dev/ (enhanced-stash-player.zip + index.yml)
npm run stash     # Stash v0.31.1 on http://localhost:9999, configured, with a test clip scanned
npm run e2e       # Playwright end-to-end tests against that Stash (starts and stops it)
docker compose down
```

`npm test` runs `node --test tests/*.test.mjs`. Plain `node --test` works too; `node --test tests/`
does not on Node 22, which reads a directory argument as a module name.

The plugin folder is mounted straight into the container, so after an edit you only need to reload
the plugins in Stash (**Settings → Plugins → Reload plugins**) and refresh the page. Stash state goes
to `tests/e2e/.stash/`, and media goes to `tests/e2e/media/`. Both are gitignored. `npm run stash`
writes a `config.yml` there on first run so Stash skips its setup wizard, makes a 120 s VP8/Opus test
clip with the container's ffmpeg, scans it and reloads the plugins.

### End-to-end tests

`npm run e2e` installs `@playwright/test` and Chromium into `tests/e2e/`, starts Stash, runs
`tests/e2e/player.spec.mjs` and runs `docker compose down` at the end. Set `ESP_E2E_KEEP=1` to leave
Stash running. The tests cover: no console errors from the plugin, the flag saving `esp_start_at`,
reload + play jumping (and the jump not being counted), Undo and Skip intro, play + pause writing
`esp_watch_<id>`, two tabs counting at once with nothing lost, the graph and its tick, and the
`pagehide` keepalive save landing and being confirmed on the next load. Playback is muted and
Chromium runs with `--autoplay-policy=no-user-gesture-required`. The clip is WebM because
Playwright's Chromium has no H.264.

### Releasing

Every push to `main` publishes the dev channel to GitHub Pages. To release, push a tag:
`git tag v0.1.0 && git push origin v0.1.0`. The stable channel is built from the newest `v*` tag,
with the version taken from the tag. Both channels are rebuilt on every deploy.

Layout:

- `enhanced-stash-player/`: the plugin, shipped as-is.
  - `esp-core.js` holds the pure helpers. The node tests load it too.
  - `esp-main.js` handles wiring and loads last.
  - `esp-starts-at.js`, `esp-tracker.js` and `esp-graph.js` are the feature modules.
  - `enhanced-stash-player.css` holds all styles.
- `scripts/`: `build.mjs` (zip + index.yml per channel) and `check-manifest.mjs`.
- `tests/`: unit tests. `tests/e2e/`: Playwright tests and the Docker Stash helpers.
- `docs/PLAN.md`: the spec.
- `docs/CONTRACT.md`: the interfaces between modules.

## License

The Unlicense. See `LICENSE`.
