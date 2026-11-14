// Enhanced Stash Player: pure helpers (no DOM). Also loaded by the node tests.
(function (root) {
  "use strict";

  const ESP = (root.ESP = root.ESP || {});

  const PLUGIN_ID = "enhanced-stash-player";
  const MIN_VERSION = "v0.31.0";
  const BUCKETS = 200;
  const MAX_COUNT = 65535;
  const MAX_STEP = 1.5;
  const TENTHS = 10;
  const FORMAT_PREFIX = "v1:";
  const START_FIELD = "esp_start_at";
  const WATCH_PREFIX = "esp_watch_";
  const AUTO_JUMP_MAX_TIME = 15;
  const SKIP_MARGIN = 2;
  const PENDING_STALE_MS = 15000;
  const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

  const keys = {
    browserId: "esp:browser-id",
    lock: "esp:lock",
    pendingPrefix: (sceneId) => "esp:pending:" + sceneId + ":",
    pending: (sceneId, tabId) => "esp:pending:" + sceneId + ":" + tabId,
    last: (sceneId) => "esp:last:" + sceneId,
    inflight: (sceneId) => "esp:inflight:" + sceneId,
  };

  const DEFAULT_SETTINGS = Object.freeze({
    disableAutoJump: false,
    leadIn: 0,
    hideGraph: false,
    disableTracking: false,
  });

  // ---- time ----

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatTime(seconds) {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? h + ":" + pad2(m) + ":" + pad2(s) : m + ":" + pad2(s);
  }

  // ---- buckets ----

  function zeros() {
    return new Array(BUCKETS).fill(0);
  }

  function toNumber(v) {
    return Number.isFinite(v) ? v : 0;
  }

  function addBuckets(a, b) {
    const out = zeros();
    for (let i = 0; i < BUCKETS; i++) out[i] = toNumber(a && a[i]) + toNumber(b && b[i]);
    return out;
  }

  function maxBuckets(a, b) {
    const out = zeros();
    for (let i = 0; i < BUCKETS; i++) out[i] = Math.max(toNumber(a && a[i]), toNumber(b && b[i]));
    return out;
  }

  function hasCounts(buckets) {
    if (!buckets) return false;
    for (let i = 0; i < buckets.length; i++) if (buckets[i] > 0) return true;
    return false;
  }

  function isCountableStep(from, to) {
    const step = to - from;
    return Number.isFinite(step) && step > 0 && step <= MAX_STEP;
  }

  // Adds the played span [from, to) to buckets in place, in tenths of a play per bucket.
  // Returns the tenths added; 0 when the step is a seek/rewind/pause or duration is unknown.
  function applyStep(buckets, duration, from, to) {
    if (!(duration > 0) || !Number.isFinite(duration) || !isCountableStep(from, to)) return 0;
    const start = Math.max(0, from);
    const end = Math.min(duration, to);
    if (end <= start) return 0;
    const width = duration / BUCKETS;
    let added = 0;
    for (let i = Math.floor(start / width); i < BUCKETS && i * width < end; i++) {
      const overlap = Math.min(end, (i + 1) * width) - Math.max(start, i * width);
      if (overlap <= 0) continue;
      const tenths = (overlap / width) * TENTHS;
      buckets[i] = toNumber(buckets[i]) + tenths;
      added += tenths;
    }
    return added;
  }

  // ---- v1 watch format: "v1:" + base64(200 x uint16 LE) ----

  function clampCount(v) {
    const n = Math.round(toNumber(v));
    return n < 0 ? 0 : n > MAX_COUNT ? MAX_COUNT : n;
  }

  function encodeWatch(buckets) {
    let bin = "";
    for (let i = 0; i < BUCKETS; i++) {
      const n = clampCount(buckets && buckets[i]);
      bin += String.fromCharCode(n & 0xff, n >> 8);
    }
    return FORMAT_PREFIX + btoa(bin);
  }

  function decodeWatch(value) {
    const out = zeros();
    if (typeof value !== "string" || value.indexOf(FORMAT_PREFIX) !== 0) return out;
    let bin;
    try {
      bin = atob(value.slice(FORMAT_PREFIX.length));
    } catch (e) {
      return out;
    }
    if (bin.length !== BUCKETS * 2) return out;
    for (let i = 0; i < BUCKETS; i++) out[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    return out;
  }

  function watchFieldKey(browserId) {
    return WATCH_PREFIX + browserId;
  }

  function isWatchField(key) {
    return typeof key === "string" && key.indexOf(WATCH_PREFIX) === 0 && key.length > WATCH_PREFIX.length;
  }

  function sumWatchFields(customFields) {
    let sum = zeros();
    if (!customFields || typeof customFields !== "object") return sum;
    for (const key of Object.keys(customFields)) {
      if (isWatchField(key)) sum = addBuckets(sum, decodeWatch(customFields[key]));
    }
    return sum;
  }

  // Q29: base = max(server, last written here), unless the server field vanished after we
  // wrote it (the user deleted it) - then start from zeros and forget esp:last.
  function mergeBase(serverValue, lastValue) {
    const serverAbsent = serverValue === undefined || serverValue === null;
    const hadWritten = lastValue !== undefined && lastValue !== null;
    if (serverAbsent && hadWritten) return { base: zeros(), dropLast: true };
    return { base: maxBuckets(decodeWatch(serverValue), decodeWatch(lastValue)), dropLast: false };
  }

  function nextWatchValue(serverValue, lastValue, pending) {
    const merged = mergeBase(serverValue, lastValue);
    const value = encodeWatch(addBuckets(merged.base, pending));
    return { value, buckets: decodeWatch(value), dropLast: merged.dropLast };
  }

  // pagehide cannot read the server: write esp:last + pending (max'd with a known server value).
  // The Q29 "deleted" rule is never applied here; a cached copy cannot tell a deletion apart
  // from a field this tab has simply not seen yet.
  function keepaliveValue(knownValue, lastValue, pending) {
    return encodeWatch(addBuckets(maxBuckets(decodeWatch(knownValue), decodeWatch(lastValue)), pending));
  }

  // ---- pending counts in localStorage ----

  function serializePending(buckets, now) {
    const counts = [];
    for (let i = 0; i < BUCKETS; i++) counts.push(Math.round(toNumber(buckets && buckets[i]) * 1000) / 1000);
    return JSON.stringify({ t: now, c: counts });
  }

  function parsePending(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return null;
    }
    if (!data || !Array.isArray(data.c) || !Number.isFinite(data.t)) return null;
    const buckets = zeros();
    for (let i = 0; i < BUCKETS; i++) buckets[i] = Math.max(0, toNumber(data.c[i]));
    return { buckets, heartbeat: data.t };
  }

  function isStale(heartbeat, now, maxAge) {
    const age = maxAge === undefined ? PENDING_STALE_MS : maxAge;
    return !Number.isFinite(heartbeat) || now - heartbeat > age;
  }

  // ---- player sources ----

  // Scene id of a Stash stream URL (/scene/<id>/stream...), or null for anything else.
  function streamSceneId(src) {
    const m = /\/scene\/(\d+)\/stream/.exec(String(src || ""));
    return m ? m[1] : null;
  }

  // The source without Stash's transcode "start" parameter, which changes on every seek.
  function sourceKey(src) {
    const text = String(src || "");
    const q = text.indexOf("?");
    if (q < 0) return text;
    const params = text
      .slice(q + 1)
      .split("&")
      .filter((p) => p && p.split("=")[0] !== "start");
    return text.slice(0, q) + (params.length ? "?" + params.join("&") : "");
  }

  // ---- graph ----

  function smooth(values, windowSize) {
    const size = windowSize === undefined ? 5 : windowSize;
    const half = Math.floor(size / 2);
    const out = new Array(values.length);
    for (let i = 0; i < values.length; i++) {
      let sum = 0;
      let n = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
        sum += toNumber(values[j]);
        n++;
      }
      out[i] = sum / n;
    }
    return out;
  }

  function scaleHeights(values, height) {
    let max = 0;
    for (const v of values) if (v > max) max = v;
    return values.map((v) => (max > 0 ? (Math.max(0, toNumber(v)) / max) * height : 0));
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // Closed SVG area path: one point per bucket centre, baseline at y = height.
  function areaPath(heights, width, height) {
    const n = heights.length;
    if (!n) return "";
    const step = width / n;
    let d = "M0," + round2(height) + " L0," + round2(height - heights[0]);
    for (let i = 0; i < n; i++) d += " L" + round2((i + 0.5) * step) + "," + round2(height - heights[i]);
    d += " L" + round2(width) + "," + round2(height - heights[n - 1]);
    return d + " L" + round2(width) + "," + round2(height) + " Z";
  }

  // ---- starts at ----

  function parseStartAt(value) {
    if (value === undefined || value === null || value === "" || typeof value === "boolean") return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function jumpTarget(startAt, leadIn) {
    return Math.max(0, startAt - (toNumber(leadIn) || 0));
  }

  // Seconds to auto-jump to on first `playing`, or null for no jump.
  function autoJumpTarget(opts) {
    const startAt = parseStartAt(opts.startAt);
    if (opts.disabled || opts.userSeeked || startAt === null) return null;
    const t = opts.currentTime;
    if (!(t < AUTO_JUMP_MAX_TIME) || !(t < startAt)) return null;
    const target = jumpTarget(startAt, opts.leadIn);
    return target > t ? target : null;
  }

  function shouldShowSkip(opts) {
    const startAt = parseStartAt(opts.startAt);
    return startAt !== null && !opts.jumped && opts.currentTime < startAt - SKIP_MARGIN;
  }

  // ---- settings ----

  function toBool(v) {
    return v === true || v === "true" || v === 1;
  }

  function normalizeSettings(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    let leadIn = Number(s.leadIn);
    if (!Number.isFinite(leadIn)) leadIn = DEFAULT_SETTINGS.leadIn;
    return {
      disableAutoJump: toBool(s.disableAutoJump),
      leadIn: Math.min(60, Math.max(0, leadIn)),
      hideGraph: toBool(s.hideGraph),
      disableTracking: toBool(s.disableTracking),
    };
  }

  // ---- versions ----

  function parseVersion(v) {
    const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
  }

  // -1, 0 or 1; null when either side cannot be parsed. Suffixes like "-12-gabc" are ignored.
  function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    return 0;
  }

  // Unknown versions are allowed: only block when we know the server is too old.
  function isSupportedVersion(v) {
    const cmp = compareVersions(v, MIN_VERSION);
    return cmp === null || cmp >= 0;
  }

  // ---- ids ----

  function randomId(length, rand) {
    const n = length || 8;
    let out = "";
    if (!rand && root.crypto && root.crypto.getRandomValues) {
      const bytes = root.crypto.getRandomValues(new Uint8Array(n));
      for (let i = 0; i < n; i++) out += ID_CHARS[bytes[i] % ID_CHARS.length];
      return out;
    }
    const r = rand || Math.random;
    for (let i = 0; i < n; i++) out += ID_CHARS[Math.floor(r() * ID_CHARS.length) % ID_CHARS.length];
    return out;
  }

  // ---- localStorage lock (Web Locks are unavailable on plain http) ----

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function lockOptions(opts) {
    return {
      storage: opts.storage,
      owner: opts.owner,
      key: opts.key || keys.lock,
      now: opts.now || Date.now,
      sleep: opts.sleep || defaultSleep,
      ttl: opts.ttl || 5000,
      settle: opts.settle || 50,
      retry: opts.retry || 250,
      timeout: opts.timeout || 5000,
    };
  }

  function readLock(storage, key) {
    try {
      const lock = JSON.parse(storage.getItem(key));
      return lock && typeof lock.owner === "string" ? lock : null;
    } catch (e) {
      return null;
    }
  }

  // Resolves true once `owner` holds the lock, false after `timeout` ms of contention.
  // A lock is free when absent or expired; holding it again from the same owner waits too,
  // so overlapping saves within one tab also serialize.
  async function acquireLock(options) {
    const o = lockOptions(options);
    const deadline = o.now() + o.timeout;
    for (;;) {
      const current = readLock(o.storage, o.key);
      if (!current || !(current.until > o.now())) {
        o.storage.setItem(o.key, JSON.stringify({ owner: o.owner, until: o.now() + o.ttl }));
        await o.sleep(o.settle);
        const after = readLock(o.storage, o.key);
        if (after && after.owner === o.owner) return true;
      }
      if (o.now() + o.retry > deadline) return false;
      await o.sleep(o.retry);
    }
  }

  function releaseLock(options) {
    const o = lockOptions(options);
    const current = readLock(o.storage, o.key);
    if (!current || current.owner !== o.owner) return false;
    o.storage.removeItem(o.key);
    return true;
  }

  // Runs fn while holding the lock. Resolves {locked: false} if the lock was not obtained.
  // Each acquisition gets its own token: a holder that outlived the ttl must not release the
  // lock a later holder (possibly in the same tab) took over.
  async function withLock(options, fn) {
    const held = Object.assign({}, options, { owner: options.owner + ":" + randomId(6) });
    if (!(await acquireLock(held))) return { locked: false };
    try {
      return { locked: true, value: await fn() };
    } finally {
      releaseLock(held);
    }
  }

  const core = {
    PLUGIN_ID,
    MIN_VERSION,
    BUCKETS,
    MAX_COUNT,
    MAX_STEP,
    START_FIELD,
    WATCH_PREFIX,
    AUTO_JUMP_MAX_TIME,
    PENDING_STALE_MS,
    DEFAULT_SETTINGS,
    keys,
    formatTime,
    zeros,
    addBuckets,
    maxBuckets,
    hasCounts,
    isCountableStep,
    applyStep,
    encodeWatch,
    decodeWatch,
    watchFieldKey,
    isWatchField,
    sumWatchFields,
    mergeBase,
    nextWatchValue,
    keepaliveValue,
    streamSceneId,
    sourceKey,
    serializePending,
    parsePending,
    isStale,
    smooth,
    scaleHeights,
    areaPath,
    parseStartAt,
    jumpTarget,
    autoJumpTarget,
    shouldShowSkip,
    normalizeSettings,
    parseVersion,
    compareVersions,
    isSupportedVersion,
    randomId,
    acquireLock,
    releaseLock,
    withLock,
  };

  ESP.core = core;
  if (typeof module !== "undefined" && module.exports) module.exports = core;
})(typeof window !== "undefined" ? window : globalThis);
