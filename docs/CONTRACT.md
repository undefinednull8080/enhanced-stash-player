# Module contract (v0.1.0)

How the plugin files fit together. `docs/PLAN.md` is the product spec. This file covers the
interfaces between files. If they conflict, PLAN wins. Raise a conflict instead of working around it.

## Files and owners

| File | Owner | Notes |
| --- | --- | --- |
| `enhanced-stash-player/enhanced-stash-player.yml` | foundation | load order below |
| `enhanced-stash-player/esp-core.js` | foundation | pure helpers, `ESP.core` |
| `enhanced-stash-player/esp-main.js` | foundation | wiring, `ctx`, toasts, bus |
| `enhanced-stash-player/esp-starts-at.js` | **starts-at agent** | `ESP.startsAt` |
| `enhanced-stash-player/enhanced-stash-player.css` | shared | one stylesheet (PLAN layout): toasts, Starts At, graph sections |
| `enhanced-stash-player/esp-tracker.js` | **tracker agent** | `ESP.tracker` |
| `enhanced-stash-player/esp-graph.js` | **graph agent** | `ESP.graph` |
| `scripts/build.mjs`, `.github/workflows/ci.yml`, `.github/workflows/pages.yml`, `tests/build.test.mjs` | **packaging agent** | |
| `tests/e2e/**` | **packaging agent** (or e2e agent) | Playwright against `docker-compose.yml` |
| `tests/core.test.mjs`, `package.json`, `.gitignore`, `docker-compose.yml`, `README.md`, `docs/CONTRACT.md` | foundation | |

Module agents can add their own `tests/<module>.test.mjs` (for example `tests/tracker.test.mjs`).
To change a file you do not own, describe the change in your result. If you need a new pure helper,
ask for it in `esp-core.js`. Until it lands, keep it as a private function in your own file, written
so that it can move into core later.

## Load order and namespace

The manifest's `ui.javascript` order is `esp-core.js`, `esp-starts-at.js`, `esp-tracker.js`,
`esp-graph.js`, `esp-main.js`. The only `ui.css` file is `enhanced-stash-player.css`.

Every file is an IIFE that starts with `const ESP = (window.ESP = window.ESP || {});` and attaches
one export. Feature files must have **no side effects at load time**: no DOM work, no listeners, no
GraphQL. Do all work in `attach(ctx)`. `esp-main.js` loads last and starts everything.

## Module interface

```js
ESP.startsAt = { attach(ctx) { ...; return function detach() { ... }; } };
ESP.tracker  = { attach(ctx) { ...; return function detach() { ... }; } };
ESP.graph    = { attach(ctx) { ...; return function detach() { ... }; } };
```

- `attach(ctx)` is called once per scene visit, after the video.js player is `ready()`. The modules
  are attached in the order startsAt, tracker, graph. Each attach is wrapped in try/catch, so one
  failing module does not block the others.
- main does **not** attach the tracker when `settings.disableTracking` is true. It does not attach
  the graph when `settings.hideGraph` is true. Modules can assume those settings are false.
  starts-at is always attached and must check `settings.disableAutoJump` itself.
- `detach()` must remove every listener, timer, observer and DOM node that the module added. It is
  called in reverse order (graph, tracker, startsAt) when any of these happens:
  - the route leaves `/scenes/<id>`
  - the route changes to a different scene id. This includes queue advance, where **the same player
    object is reused with a new source**.
  - the player is disposed. main then re-attaches if the route is still a scene.

  The return value of `detach()` is ignored and main does not await it. The tracker can start its
  final async save inside `detach()`. `ctx.gql` and `ctx.updateCustomFields` keep working after
  detach. The bus does not: emits after detach go nowhere.
- Leaving the page and then coming back to the same scene gives a fresh `attach` with a new `ctx`.
  A location event for the same scene id, such as a query-string change, does not re-attach.

## `ctx` (one object per scene visit)

| Member | Type | Meaning |
| --- | --- | --- |
| `sceneId` | string | Stash scene id from `/scenes/<id>` |
| `player` | video.js Player | from `PluginApi.utils.InteractiveUtils.getPlayer()`, already `ready()`. Seek with `player.currentTime(t)` |
| `settings` | object | `ESP.core.normalizeSettings` output: `{disableAutoJump: bool, leadIn: number 0–60, hideGraph: bool, disableTracking: bool}`. Loaded once per page load |
| `duration` | number | first file's `duration` from GraphQL, in seconds. 0 if unknown |
| `getDuration()` | () => number | `duration`, or else `player.duration()` when finite and > 0, or else 0 |
| `customFields` | object | latest known `custom_fields` map of the scene. Replaced (not mutated) on every read or update. Always read `ctx.customFields` fresh; do not cache it |
| `tabId` | string | 8 chars `[a-z0-9]`, new on each page load, shared by all scenes in that load |
| `browserId` | string | 8 chars `[a-z0-9]`, persisted in localStorage `esp:browser-id` |
| `storage` | object | localStorage wrapper that **never throws**: `getItem(k) → string|null`, `setItem(k, v) → bool`, `removeItem(k)`, `keys() → string[]`. Pass it to the `ESP.core` lock functions |
| `storageOk` | bool | false when localStorage is unusable. The tracker must not count or save then, because `browserId` would change on every load |
| `core` | object | same as `ESP.core` |
| `active` | bool | true until `detach`. Check it in async continuations before you touch the DOM or player |
| `gql(query, variables?, options?)` | → Promise<data> | POST to Stash `graphql` (base-path aware, same-origin cookies). Resolves `body.data`. Rejects on HTTP error or on any GraphQL `errors`. `options.keepalive: true` sets `fetch(..., {keepalive: true})` (for `pagehide`) |
| `readCustomFields()` | → Promise<object> | `findScene(id) { custom_fields }`. Sets `ctx.customFields`, emits `fieldsChanged`, resolves the map |
| `updateCustomFields({partial?, remove?}, options?)` | → Promise<object> | `sceneUpdate(input: {id, custom_fields: {partial, remove}})`. Empty parts are left out. If both are empty, nothing is sent and it resolves the current map. A key must not be in both. Values must be scalars. Sets `ctx.customFields` from the response, emits `fieldsChanged`, resolves the new map. `options.keepalive` is the same as for `gql` |
| `toast(text, undoFn?)` | → remove() | Shows a toast inside the player element (also visible in fullscreen) for 6 s. With `undoFn`, it adds an "Undo" button; a click removes the toast and calls `undoFn()`. Returns a function that removes the toast early |
| `on(event, fn)` | → off() | subscribe to the bus. Returns the unsubscribe function |
| `emit(event, payload)` | void | synchronous. Listener errors are caught and logged |

Toast DOM: `.esp-toasts > .esp-toast > span + button.esp-toast-undo`. The page-level variant
(version warning, no player) adds the class `esp-toasts--page`.

## Event bus (per ctx)

| Event | Emitted by | Payload | Listener |
| --- | --- | --- | --- |
| `ourSeek` | starts-at, **synchronously before** each `player.currentTime(to)` | `{from: number, to: number}` | tracker: the next `timeupdate`/`seeking` from this jump is not counted and not treated as the viewer's seek. Set `lastTime = to` |
| `startAtChanged` | starts-at, after `esp_start_at` is saved, removed or undone | `{startAt: number \| null}` | graph: move or hide the tick |
| `saved` | tracker, after every successful write of its `esp_watch_<browserId>` field (normal save, adoption or inflight re-apply) | `{field: string, value: string, buckets: number[200], customFields: object}`. `buckets` is `value` decoded | graph: redraw from `customFields` (or `ctx.customFields`) |
| `fieldsChanged` | main, whenever `ctx.customFields` is replaced (by `readCustomFields` or `updateCustomFields`) | `{customFields: object}` | optional. Graph or starts-at can use it to resync |

Modules must not emit another module's events. Do not add new events without updating this table
(ask the foundation owner).

## `ESP.core` API (`esp-core.js`)

This file is pure, with no DOM. Under node, `createRequire(import.meta.url)("../enhanced-stash-player/esp-core.js")`
returns the same object.

The core includes the pure logic the module agents need, so tests can cover it.

### Constants

`PLUGIN_ID = "enhanced-stash-player"`, `MIN_VERSION = "v0.31.0"`, `BUCKETS = 200`,
`MAX_COUNT = 65535`, `MAX_STEP = 1.5`, `START_FIELD = "esp_start_at"`,
`WATCH_PREFIX = "esp_watch_"`, `AUTO_JUMP_MAX_TIME = 15`, `PENDING_STALE_MS = 15000`,
`DEFAULT_SETTINGS` (frozen).

`keys`:

- `keys.browserId` is `"esp:browser-id"`
- `keys.lock` is `"esp:lock"`
- `keys.pendingPrefix(sceneId)` is `"esp:pending:<sceneId>:"`
- `keys.pending(sceneId, tabId)` is `"esp:pending:<sceneId>:<tabId>"`
- `keys.last(sceneId)` is `"esp:last:<sceneId>"`
- `keys.inflight(sceneId)` is `"esp:inflight:<sceneId>"`. Its value is JSON
  `{<tabId>: {v, t, c, a?, ac?}}`: `v` the encoded value the keepalive wrote, `t` the time in ms, `c`
  the 200 counts it carried, and, when a normal save was on the wire at `pagehide`, `a` that save's
  value and `ac` its counts. Owned by the tracker

### Time

- `formatTime(seconds) → "m:ss" | "h:mm:ss"`. Floors the value. Invalid or negative input gives `"0:00"`.

### Buckets

Buckets are plain arrays of 200 numbers, in tenths of a play. They can be fractional until encoded.

- `zeros() → number[200]`
- `addBuckets(a, b) → new array` and `maxBuckets(a, b) → new array`. Missing or non-finite entries
  count as 0.
- `hasCounts(buckets) → bool`. True if any bucket is > 0.
- `isCountableStep(from, to) → bool`. True when `0 < to-from <= 1.5`.
- `applyStep(buckets, duration, from, to) → tenthsAdded`. Mutates `buckets`. Bucket i covers
  `[i*d/200, (i+1)*d/200)`. Each bucket the step touches gets `overlap/width*10`. The step is
  clamped to `[0, duration]`. Returns 0 and changes nothing for a seek or rewind, a zero step, or an
  unknown duration. **The caller checks** `playbackRate === 1` and "is playing".

### Watch format (v1)

- `encodeWatch(buckets) → "v1:" + base64(200 × uint16 LE)`. Rounds, and clamps each value to 0..65535.
- `decodeWatch(value) → number[200]` of integers. Anything missing or invalid, including the wrong
  length or wrong prefix, gives zeros.
- `watchFieldKey(browserId) → "esp_watch_<browserId>"`. `isWatchField(key) → bool`.
- `sumWatchFields(customFields) → number[200]`. Decoded and summed over every `esp_watch_*` key. The
  sum is not saturated.

### Save merge (Q29)

- `mergeBase(serverValue, lastValue) → {base, dropLast}`. Both arguments are encoded strings or
  `undefined`/`null`.
  - If the server value is absent (`undefined`/`null`) and `lastValue` is present, the user deleted
    the field. The result is `{base: zeros, dropLast: true}`, and the caller removes `esp:last`.
  - Otherwise the result is `{base: max(decode(server), decode(last)), dropLast: false}`. A present
    but invalid server string counts as present and decodes to zeros.
- `nextWatchValue(serverValue, lastValue, pending) → {value, buckets, dropLast}`. `value` is
  `encodeWatch(base + pending)`. `buckets` is `decodeWatch(value)`, the integers that were actually
  written.

### Pending in localStorage

- `serializePending(buckets, now) → '{"t":now,"c":[...200]}'`. Counts keep 3 decimals.
- `parsePending(text) → {buckets, heartbeat} | null`
- `isStale(heartbeat, now, maxAge = 15000) → bool`. True if older than `maxAge` or not a number.

### Graph

- `smooth(values, windowSize = 5) → number[]`. Centered moving average. At the edges it averages the
  neighbours that exist.
- `scaleHeights(values, height) → number[]`. The max maps to `height`. All zeros stay zeros.
- `areaPath(heights, width, height) → string`. A closed SVG path `d`, with one point per bucket
  centre and the baseline at `y = height`. Empty input gives `""`.

### Starts At

- `parseStartAt(value) → number >= 0 | null`. Accepts a number or a numeric string. A boolean, an
  empty value, a negative or NaN gives null.
- `jumpTarget(startAt, leadIn) → max(0, startAt - leadIn)`. Both the auto-jump and the Skip intro
  button use this.
- `autoJumpTarget({startAt, currentTime, leadIn, userSeeked, disabled}) → seconds | null`. It
  returns null in any of these cases:
  - `disabled` or `userSeeked` is true
  - no start is set
  - `currentTime >= 15`
  - `currentTime >= startAt`
  - the target would not be ahead of `currentTime`
- `shouldShowSkip({startAt, currentTime, jumped}) → bool`. True when a start is set, `!jumped` and
  `currentTime < startAt - 2`.

### Settings and version

- `normalizeSettings(raw) → {disableAutoJump, leadIn, hideGraph, disableTracking}`. The booleans
  accept `true`, `"true"` or `1`. `leadIn` is `Number()`, then clamped to 0..60, and NaN becomes 0.
- `parseVersion(v) → [major, minor, patch] | null`. A leading `v` is optional and suffixes are
  ignored.
- `compareVersions(a, b) → -1 | 0 | 1 | null`. null means unparseable.
- `isSupportedVersion(v) → bool`. True when the version is >= v0.31.0, and **also true when it is
  unknown or unparseable**.

### Ids

- `randomId(length = 8, rand?) → [a-z0-9]{length}`. Uses `crypto.getRandomValues` unless `rand`
  (a `() => [0,1)` function) is given.

### Lock (localStorage, between tabs of one browser)

`options` is `{storage, owner, key = "esp:lock", now = Date.now, sleep = ms => Promise, ttl = 5000,
settle = 50, retry = 250, timeout = 5000}`. `storage` must not throw; use `ctx.storage`. `owner` is
`ctx.tabId`.

- `acquireLock(options) → Promise<bool>`. When the lock is absent or expired, it writes
  `{owner, until: now+ttl}`, waits `settle` ms and re-reads. If the lock is still ours, it resolves
  true. Otherwise it retries every `retry` ms and resolves false after `timeout` ms. A live lock
  that the **same owner** already holds also blocks, so overlapping saves in one tab serialize.
- `releaseLock(options) → bool`. Removes the lock only if `owner` holds it.
- `withLock(options, fn) → Promise<{locked: false} | {locked: true, value}>`. Runs `await fn()`
  while holding the lock and always releases it afterwards. If `fn` throws, `withLock` rejects
  (after the release). When it resolves `{locked: false}`, keep the counts pending.
- The lock does not refresh while held, so finish the read and write well within `ttl` (5 s).

## main behaviour (for reference)

- Runs once per page load:
  - `query { version { version } }`. If `!isSupportedVersion`, it logs `console.warn` and shows one
    page toast, and nothing is ever attached.
  - `query { configuration { plugins(include: ["enhanced-stash-player"]) } }`, then
    `normalizeSettings`. If this fails, the defaults are used.
- Routes come from `PluginApi.Event` `stash:location` (`e.detail.data.location.pathname`) and from
  the current URL at startup, with Stash's `<base href>` stripped. A scene route matches
  `^/scenes/(\d+)/?$`.
- When a scene route matches, main polls `getPlayer()` every 100 ms, for up to 15 s, until it gets
  a non-disposed player. It then runs `player.ready()` and fetches
  `findScene(id) { id custom_fields files { duration } }` in parallel, builds `ctx`, and attaches
  the modules. A newer navigation cancels any work still pending.
- `ESP.main` is exposed for debugging and e2e: `{tabId, storage, gql, handlePath(path),
  leaveScene(), current() → ctx | null}`.
