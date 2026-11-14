import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../enhanced-stash-player/esp-core.js");

const N = core.BUCKETS;

function filled(fn) {
  return Array.from({ length: N }, (_, i) => fn(i));
}

function near(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} !~ ${expected}`);
}

describe("loading", () => {
  test("exports the core and sets globalThis.ESP.core", () => {
    assert.equal(typeof core.applyStep, "function");
    assert.equal(globalThis.ESP.core, core);
    assert.equal(N, 200);
  });
});

describe("formatTime", () => {
  test("minutes and seconds", () => {
    assert.equal(core.formatTime(0), "0:00");
    assert.equal(core.formatTime(5), "0:05");
    assert.equal(core.formatTime(83), "1:23");
    assert.equal(core.formatTime(83.99), "1:23");
    assert.equal(core.formatTime(600), "10:00");
    assert.equal(core.formatTime(3599), "59:59");
  });
  test("hours", () => {
    assert.equal(core.formatTime(3600), "1:00:00");
    assert.equal(core.formatTime(3723), "1:02:03");
    assert.equal(core.formatTime(36000), "10:00:00");
  });
  test("invalid input", () => {
    for (const v of [-1, NaN, Infinity, undefined, null, "12"]) assert.equal(core.formatTime(v), "0:00");
  });
});

describe("watch format", () => {
  test("round trip", () => {
    const buckets = filled((i) => i * 300);
    const value = core.encodeWatch(buckets);
    assert.match(value, /^v1:[A-Za-z0-9+/]+=*$/);
    assert.equal(value.length, 3 + Math.ceil((N * 2) / 3) * 4);
    assert.deepEqual(core.decodeWatch(value), buckets);
  });
  test("little-endian uint16 layout", () => {
    const b = core.zeros();
    b[0] = 0x0102;
    b[1] = 0xff;
    const bin = atob(core.encodeWatch(b).slice(3));
    assert.deepEqual([0, 1, 2, 3].map((i) => bin.charCodeAt(i)), [0x02, 0x01, 0xff, 0x00]);
  });
  test("rounds, saturates at 65535, clamps negatives and junk", () => {
    const b = core.zeros();
    b[0] = 1.4;
    b[1] = 1.6;
    b[2] = 70000;
    b[3] = -5;
    b[4] = NaN;
    const out = core.decodeWatch(core.encodeWatch(b));
    assert.deepEqual(out.slice(0, 5), [1, 2, 65535, 0, 0]);
  });
  test("encodes short or missing arrays as zeros past the end", () => {
    assert.deepEqual(core.decodeWatch(core.encodeWatch([7])), [7, ...new Array(N - 1).fill(0)]);
    assert.deepEqual(core.decodeWatch(core.encodeWatch(undefined)), core.zeros());
  });
  test("decode tolerates missing and invalid values", () => {
    for (const v of [undefined, null, "", 42, true, {}, "v2:AAAA", "v1:", "v1:%%%", "v1:AAAA", "AAAA"]) {
      assert.deepEqual(core.decodeWatch(v), core.zeros(), String(v));
    }
  });
  test("decode returns a fresh array each time", () => {
    const a = core.decodeWatch(undefined);
    a[0] = 9;
    assert.equal(core.decodeWatch(undefined)[0], 0);
  });
});

describe("applyStep", () => {
  const D = 200; // 1 s per bucket

  test("half a bucket adds 5 tenths", () => {
    const b = core.zeros();
    assert.equal(core.applyStep(b, D, 10, 10.5), 5);
    near(b[10], 5);
    assert.equal(b[9] + b[11], 0);
  });
  test("split across a boundary", () => {
    const b = core.zeros();
    near(core.applyStep(b, D, 10.75, 11.25), 5);
    near(b[10], 2.5);
    near(b[11], 2.5);
  });
  test("step of exactly 1.5 counts, larger is a seek", () => {
    const b = core.zeros();
    near(core.applyStep(b, D, 0, 1.5), 15);
    near(b[0], 10);
    near(b[1], 5);
    const c = core.zeros();
    assert.equal(core.applyStep(c, D, 0, 1.51), 0);
    assert.deepEqual(c, core.zeros());
  });
  test("zero, negative and non-finite steps are ignored", () => {
    const b = core.zeros();
    assert.equal(core.applyStep(b, D, 5, 5), 0);
    assert.equal(core.applyStep(b, D, 5, 4), 0);
    assert.equal(core.applyStep(b, D, NaN, 4), 0);
    assert.equal(core.applyStep(b, D, 4, Infinity), 0);
    assert.deepEqual(b, core.zeros());
  });
  test("unknown duration is ignored", () => {
    const b = core.zeros();
    for (const d of [0, -1, NaN, Infinity, undefined]) assert.equal(core.applyStep(b, d, 1, 2), 0);
    assert.deepEqual(b, core.zeros());
  });
  test("clamps to [0, duration]", () => {
    const b = core.zeros();
    near(core.applyStep(b, D, -0.5, 0.5), 5);
    near(b[0], 5);
    near(core.applyStep(b, D, 199.5, 200.5), 5);
    near(b[199], 5);
    assert.equal(core.applyStep(b, D, 200, 201), 0);
  });
  test("last bucket boundary at exactly duration", () => {
    const b = core.zeros();
    near(core.applyStep(b, D, 199, 200), 10);
    near(b[199], 10);
  });
  test("rewinds that replay add again", () => {
    const b = core.zeros();
    core.applyStep(b, D, 20, 21);
    core.applyStep(b, D, 20, 21);
    near(b[20], 20);
  });
  test("short scenes: one step spans many buckets", () => {
    const b = core.zeros();
    const d = 10; // 0.05 s per bucket
    near(core.applyStep(b, d, 0, 1), 200);
    for (let i = 0; i < 20; i++) near(b[i], 10, 1e-6);
    assert.equal(b[20], 0);
  });
  test("a whole playthrough adds 10 tenths everywhere", () => {
    const b = core.zeros();
    const d = 123.4;
    for (let t = 0; t < d; t += 0.25) core.applyStep(b, d, t, Math.min(d, t + 0.25));
    for (let i = 0; i < N; i++) near(b[i], 10, 1e-6);
    assert.deepEqual(core.decodeWatch(core.encodeWatch(b)), new Array(N).fill(10));
  });
  test("saturation after many plays", () => {
    const b = core.zeros();
    for (let k = 0; k < 7000; k++) core.applyStep(b, D, 0, 1);
    assert.equal(core.decodeWatch(core.encodeWatch(b))[0], 65535);
  });
  test("isCountableStep", () => {
    assert.equal(core.isCountableStep(1, 2), true);
    assert.equal(core.isCountableStep(1, 2.5), true);
    assert.equal(core.isCountableStep(1, 2.6), false);
    assert.equal(core.isCountableStep(1, 1), false);
  });
});

describe("bucket math", () => {
  test("addBuckets and maxBuckets do not mutate and tolerate holes", () => {
    const a = filled((i) => i);
    const b = filled((i) => (i % 2 ? 100 : 0));
    const sum = core.addBuckets(a, b);
    assert.equal(sum[1], 101);
    assert.equal(sum[2], 2);
    assert.equal(a[1], 1);
    const max = core.maxBuckets(a, b);
    assert.equal(max[1], 100);
    assert.equal(max[150], 150);
    assert.deepEqual(core.addBuckets(undefined, [1]), [1, ...new Array(N - 1).fill(0)]);
  });
  test("hasCounts", () => {
    assert.equal(core.hasCounts(core.zeros()), false);
    assert.equal(core.hasCounts(undefined), false);
    const b = core.zeros();
    b[199] = 0.1;
    assert.equal(core.hasCounts(b), true);
  });
});

describe("watch fields", () => {
  test("watchFieldKey / isWatchField", () => {
    assert.equal(core.watchFieldKey("abc12345"), "esp_watch_abc12345");
    assert.equal(core.isWatchField("esp_watch_abc12345"), true);
    assert.equal(core.isWatchField("esp_watch_"), false);
    assert.equal(core.isWatchField("esp_start_at"), false);
    assert.ok(core.watchFieldKey("abc12345").length <= 64);
  });
  test("sumWatchFields sums only esp_watch_* fields", () => {
    const a = filled(() => 3);
    const b = filled((i) => i);
    const fields = {
      esp_watch_aaaaaaaa: core.encodeWatch(a),
      esp_watch_bbbbbbbb: core.encodeWatch(b),
      esp_watch_broken: "garbage",
      esp_watch_number: 5,
      esp_start_at: 12,
      other: core.encodeWatch(a),
    };
    assert.deepEqual(core.sumWatchFields(fields), filled((i) => i + 3));
  });
  test("sumWatchFields does not saturate the sum", () => {
    const full = core.encodeWatch(new Array(N).fill(65535));
    assert.equal(core.sumWatchFields({ esp_watch_a: full, esp_watch_b: full })[0], 131070);
  });
  test("sumWatchFields on empty input", () => {
    assert.deepEqual(core.sumWatchFields(undefined), core.zeros());
    assert.deepEqual(core.sumWatchFields(null), core.zeros());
    assert.deepEqual(core.sumWatchFields({}), core.zeros());
  });
});

describe("mergeBase (Q29)", () => {
  const server = core.encodeWatch(filled((i) => (i < 100 ? 10 : 0)));
  const last = core.encodeWatch(filled((i) => (i < 100 ? 0 : 20)));

  test("bucket-wise max of server and last", () => {
    const { base, dropLast } = core.mergeBase(server, last);
    assert.equal(dropLast, false);
    assert.deepEqual(base, filled((i) => (i < 100 ? 10 : 20)));
  });
  test("edit form wiped our value: last restores it", () => {
    const { base } = core.mergeBase(core.encodeWatch(core.zeros()), last);
    assert.deepEqual(base, core.decodeWatch(last));
  });
  test("server only (first save from this browser, or esp:last lost)", () => {
    assert.deepEqual(core.mergeBase(server, null).base, core.decodeWatch(server));
    assert.deepEqual(core.mergeBase(server, undefined).base, core.decodeWatch(server));
  });
  test("neither: zeros, nothing to drop", () => {
    assert.deepEqual(core.mergeBase(undefined, null), { base: core.zeros(), dropLast: false });
  });
  test("server field absent after we wrote it: user deleted it", () => {
    assert.deepEqual(core.mergeBase(undefined, last), { base: core.zeros(), dropLast: true });
    assert.deepEqual(core.mergeBase(null, last), { base: core.zeros(), dropLast: true });
  });
  test("invalid server value is treated as present (zeros), not as a deletion", () => {
    const { base, dropLast } = core.mergeBase("junk", last);
    assert.equal(dropLast, false);
    assert.deepEqual(base, core.decodeWatch(last));
  });
  test("nextWatchValue adds pending to the merged base", () => {
    const pending = filled(() => 2.4);
    const next = core.nextWatchValue(server, last, pending);
    assert.equal(next.dropLast, false);
    assert.deepEqual(next.buckets, filled((i) => (i < 100 ? 12 : 22)));
    assert.equal(next.value, core.encodeWatch(next.buckets));
    const deleted = core.nextWatchValue(undefined, last, pending);
    assert.equal(deleted.dropLast, true);
    assert.deepEqual(deleted.buckets, filled(() => 2));
  });
});

describe("pending storage format", () => {
  test("round trip with heartbeat", () => {
    const b = filled((i) => i / 3);
    const parsed = core.parsePending(core.serializePending(b, 12345));
    assert.equal(parsed.heartbeat, 12345);
    for (let i = 0; i < N; i++) near(parsed.buckets[i], b[i], 1e-3);
  });
  test("invalid entries parse to null", () => {
    for (const v of [null, "", "{", "[]", '{"t":1}', '{"c":[]}', '{"t":"x","c":[]}']) {
      assert.equal(core.parsePending(v), null, String(v));
    }
  });
  test("negative and junk counts become zero", () => {
    const parsed = core.parsePending(JSON.stringify({ t: 1, c: [-1, "x", 3] }));
    assert.deepEqual(parsed.buckets.slice(0, 4), [0, 0, 3, 0]);
  });
  test("isStale", () => {
    assert.equal(core.isStale(1000, 16000), false);
    assert.equal(core.isStale(1000, 16001), true);
    assert.equal(core.isStale(1000, 1500, 100), true);
    assert.equal(core.isStale(undefined, 0), true);
  });
  test("storage keys", () => {
    assert.equal(core.keys.browserId, "esp:browser-id");
    assert.equal(core.keys.lock, "esp:lock");
    assert.equal(core.keys.pending("12", "tab1"), "esp:pending:12:tab1");
    assert.ok(core.keys.pending("12", "tab1").startsWith(core.keys.pendingPrefix("12")));
    assert.equal(core.keys.last("12"), "esp:last:12");
    assert.equal(core.keys.inflight("12"), "esp:inflight:12");
  });
});

describe("graph helpers", () => {
  test("smooth: centered moving average over 5, shrinking at edges", () => {
    const v = [0, 0, 10, 0, 0, 0, 0];
    const s = core.smooth(v);
    near(s[0], 10 / 3);
    near(s[1], 10 / 4);
    near(s[2], 2);
    near(s[3], 2);
    near(s[4], 2);
    near(s[5], 0);
    near(s[6], 0);
  });
  test("smooth keeps constants and length; custom window", () => {
    assert.deepEqual(core.smooth(new Array(N).fill(7)), new Array(N).fill(7));
    assert.deepEqual(core.smooth([1, 2, 3], 1), [1, 2, 3]);
    assert.deepEqual(core.smooth([]), []);
  });
  test("scaleHeights: max becomes full height", () => {
    assert.deepEqual(core.scaleHeights([0, 5, 10], 36), [0, 18, 36]);
    assert.deepEqual(core.scaleHeights([0, 0], 36), [0, 0]);
    assert.deepEqual(core.scaleHeights([], 36), []);
  });
  test("areaPath is a closed path along the baseline", () => {
    const d = core.areaPath([0, 36], 100, 36);
    assert.equal(d, "M0,36 L0,36 L25,36 L75,0 L100,0 L100,36 Z");
    assert.equal(core.areaPath([], 100, 36), "");
  });
});

describe("starts at helpers", () => {
  test("parseStartAt", () => {
    assert.equal(core.parseStartAt(12.5), 12.5);
    assert.equal(core.parseStartAt("30"), 30);
    assert.equal(core.parseStartAt(0), 0);
    for (const v of [undefined, null, "", "abc", -1, true, NaN]) assert.equal(core.parseStartAt(v), null, String(v));
  });
  test("jumpTarget applies lead-in, never below 0", () => {
    assert.equal(core.jumpTarget(30, 0), 30);
    assert.equal(core.jumpTarget(30, 5), 25);
    assert.equal(core.jumpTarget(3, 5), 0);
  });
  test("autoJumpTarget", () => {
    const base = { startAt: 83, currentTime: 0, leadIn: 0, userSeeked: false, disabled: false };
    assert.equal(core.autoJumpTarget(base), 83);
    assert.equal(core.autoJumpTarget({ ...base, leadIn: 3 }), 80);
    assert.equal(core.autoJumpTarget({ ...base, disabled: true }), null);
    assert.equal(core.autoJumpTarget({ ...base, userSeeked: true }), null);
    assert.equal(core.autoJumpTarget({ ...base, startAt: undefined }), null);
    assert.equal(core.autoJumpTarget({ ...base, currentTime: 14.9 }), 83);
    assert.equal(core.autoJumpTarget({ ...base, currentTime: 15 }), null); // resume point wins
    assert.equal(core.autoJumpTarget({ ...base, startAt: 10, currentTime: 12 }), null); // past start
    assert.equal(core.autoJumpTarget({ ...base, startAt: 10, currentTime: 8, leadIn: 5 }), null); // backwards
  });
  test("shouldShowSkip", () => {
    assert.equal(core.shouldShowSkip({ startAt: 30, currentTime: 0, jumped: false }), true);
    assert.equal(core.shouldShowSkip({ startAt: 30, currentTime: 28, jumped: false }), false);
    assert.equal(core.shouldShowSkip({ startAt: 30, currentTime: 27.9, jumped: false }), true);
    assert.equal(core.shouldShowSkip({ startAt: 30, currentTime: 0, jumped: true }), false);
    assert.equal(core.shouldShowSkip({ startAt: null, currentTime: 0, jumped: false }), false);
  });
});

describe("settings", () => {
  test("defaults for unset settings", () => {
    const d = { disableAutoJump: false, leadIn: 0, hideGraph: false, disableTracking: false };
    assert.deepEqual(core.normalizeSettings(undefined), d);
    assert.deepEqual(core.normalizeSettings(null), d);
    assert.deepEqual(core.normalizeSettings({}), d);
    assert.deepEqual({ ...core.DEFAULT_SETTINGS }, d);
  });
  test("booleans", () => {
    const s = core.normalizeSettings({ disableAutoJump: true, hideGraph: "true", disableTracking: "no" });
    assert.equal(s.disableAutoJump, true);
    assert.equal(s.hideGraph, true);
    assert.equal(s.disableTracking, false);
  });
  test("leadIn clamps to 0..60", () => {
    assert.equal(core.normalizeSettings({ leadIn: 5 }).leadIn, 5);
    assert.equal(core.normalizeSettings({ leadIn: "7.5" }).leadIn, 7.5);
    assert.equal(core.normalizeSettings({ leadIn: -3 }).leadIn, 0);
    assert.equal(core.normalizeSettings({ leadIn: 600 }).leadIn, 60);
    assert.equal(core.normalizeSettings({ leadIn: "abc" }).leadIn, 0);
  });
  test("ignores unknown keys", () => {
    assert.deepEqual(Object.keys(core.normalizeSettings({ foo: 1 })).sort(), [
      "disableAutoJump",
      "disableTracking",
      "hideGraph",
      "leadIn",
    ]);
  });
});

describe("versions", () => {
  test("parseVersion", () => {
    assert.deepEqual(core.parseVersion("v0.31.0"), [0, 31, 0]);
    assert.deepEqual(core.parseVersion("0.31"), [0, 31, 0]);
    assert.deepEqual(core.parseVersion("v0.31.1-12-gabcdef"), [0, 31, 1]);
    assert.equal(core.parseVersion("develop"), null);
    assert.equal(core.parseVersion(undefined), null);
  });
  test("compareVersions", () => {
    assert.equal(core.compareVersions("v0.31.0", "v0.31.0"), 0);
    assert.equal(core.compareVersions("v0.30.9", "v0.31.0"), -1);
    assert.equal(core.compareVersions("v0.31.1", "v0.31.0"), 1);
    assert.equal(core.compareVersions("v1.0.0", "v0.99.99"), 1);
    assert.equal(core.compareVersions("v0.9.0", "v0.10.0"), -1);
    assert.equal(core.compareVersions("x", "v0.31.0"), null);
  });
  test("isSupportedVersion (>= v0.31.0; unknown allowed)", () => {
    assert.equal(core.isSupportedVersion("v0.31.0"), true);
    assert.equal(core.isSupportedVersion("v0.31.1"), true);
    assert.equal(core.isSupportedVersion("v0.32.0-3-g1234567"), true);
    assert.equal(core.isSupportedVersion("v0.30.1"), false);
    assert.equal(core.isSupportedVersion("v0.28.0"), false);
    assert.equal(core.isSupportedVersion(null), true);
    assert.equal(core.isSupportedVersion(""), true);
  });
});

describe("randomId", () => {
  test("8 chars of [a-z0-9] by default", () => {
    for (let i = 0; i < 50; i++) assert.match(core.randomId(), /^[a-z0-9]{8}$/);
  });
  test("length and injected rand", () => {
    assert.match(core.randomId(12), /^[a-z0-9]{12}$/);
    assert.equal(core.randomId(3, () => 0), "aaa");
    assert.equal(core.randomId(2, () => 0.999999), "99");
  });
  test("ids differ", () => {
    const ids = new Set(Array.from({ length: 200 }, () => core.randomId()));
    assert.equal(ids.size, 200);
  });
});

// ---- lock ----

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// Fake clock with a timer queue; run() advances time to each due timer in order.
function fakeTime(start = 1000) {
  let now = start;
  let seq = 0;
  const timers = [];
  return {
    now: () => now,
    advance: (ms) => (now += ms),
    sleep: (ms) =>
      new Promise((resolve) => {
        timers.push({ at: now + ms, seq: seq++, resolve });
      }),
    async run(limit = 10000) {
      for (let i = 0; i < limit; i++) {
        await flush();
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const t = timers.shift();
        now = Math.max(now, t.at);
        t.resolve();
      }
      throw new Error("timers never settled");
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("lock", () => {
  test("acquire when free, release clears it", async () => {
    const storage = memoryStorage();
    const time = fakeTime();
    const opts = { storage, owner: "A", now: time.now, sleep: time.sleep };
    const p = core.acquireLock(opts);
    await time.run();
    assert.equal(await p, true);
    const lock = JSON.parse(storage.getItem("esp:lock"));
    assert.equal(lock.owner, "A");
    assert.equal(lock.until, 1000 + 5000);
    assert.equal(core.releaseLock(opts), true);
    assert.equal(storage.getItem("esp:lock"), null);
  });

  test("release does not remove someone else's lock", () => {
    const storage = memoryStorage();
    storage.setItem("esp:lock", JSON.stringify({ owner: "B", until: 1e15 }));
    assert.equal(core.releaseLock({ storage, owner: "A" }), false);
    assert.equal(JSON.parse(storage.getItem("esp:lock")).owner, "B");
  });

  test("expired lock is taken over", async () => {
    const storage = memoryStorage();
    const time = fakeTime(10000);
    storage.setItem("esp:lock", JSON.stringify({ owner: "B", until: 9999 }));
    const p = core.acquireLock({ storage, owner: "A", now: time.now, sleep: time.sleep });
    await time.run();
    assert.equal(await p, true);
    assert.equal(JSON.parse(storage.getItem("esp:lock")).owner, "A");
  });

  test("corrupt lock value counts as free", async () => {
    const storage = memoryStorage();
    const time = fakeTime();
    storage.setItem("esp:lock", "{not json");
    const p = core.acquireLock({ storage, owner: "A", now: time.now, sleep: time.sleep });
    await time.run();
    assert.equal(await p, true);
  });

  test("gives up after timeout when held by a live owner", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    storage.setItem("esp:lock", JSON.stringify({ owner: "B", until: 1e9 }));
    const p = core.acquireLock({ storage, owner: "A", now: time.now, sleep: time.sleep });
    await time.run();
    assert.equal(await p, false);
    assert.ok(time.now() <= 5000, "gave up within ~5 s");
    assert.ok(time.now() >= 4750);
    assert.equal(JSON.parse(storage.getItem("esp:lock")).owner, "B");
  });

  test("waits for the holder's expiry, then acquires", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    storage.setItem("esp:lock", JSON.stringify({ owner: "B", until: 1000 }));
    const p = core.acquireLock({ storage, owner: "A", now: time.now, sleep: time.sleep });
    await time.run();
    assert.equal(await p, true);
    assert.ok(time.now() >= 1000);
  });

  test("same owner calling twice serializes (second waits for release)", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    const opts = { storage, owner: "A", now: time.now, sleep: time.sleep };
    const order = [];
    const first = core.withLock(opts, async () => {
      order.push("first:start");
      await time.sleep(400);
      order.push("first:end");
    });
    await flush();
    const second = core.withLock(opts, async () => order.push("second"));
    await time.run();
    assert.deepEqual((await first).locked, true);
    assert.deepEqual((await second).locked, true);
    assert.deepEqual(order, ["first:start", "first:end", "second"]);
  });

  test("withLock releases on error and reports not locked on timeout", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    const opts = { storage, owner: "A", now: time.now, sleep: time.sleep };
    const failing = core.withLock(opts, async () => {
      throw new Error("boom");
    });
    await time.run();
    await assert.rejects(failing, /boom/);
    assert.equal(storage.getItem("esp:lock"), null);

    storage.setItem("esp:lock", JSON.stringify({ owner: "B", until: 1e12 }));
    let ran = false;
    const blocked = core.withLock(opts, async () => (ran = true));
    await time.run();
    assert.deepEqual(await blocked, { locked: false });
    assert.equal(ran, false);
  });

  test("two contending tabs: both get the lock, never at the same time", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    let holders = 0;
    let maxHolders = 0;
    const log = [];
    const tab = (owner) =>
      core.withLock({ storage, owner, now: time.now, sleep: time.sleep }, async () => {
        holders++;
        maxHolders = Math.max(maxHolders, holders);
        log.push(owner + ":in@" + time.now());
        await time.sleep(300); // simulated GraphQL read + write
        holders--;
        log.push(owner + ":out@" + time.now());
        return owner;
      });
    const a = tab("A");
    const b = tab("B");
    await time.run();
    assert.deepEqual(await a, { locked: true, value: "A" });
    assert.deepEqual(await b, { locked: true, value: "B" });
    assert.equal(maxHolders, 1);
    assert.equal(log.length, 4);
    assert.equal(storage.getItem("esp:lock"), null);
  });

  test("two tabs that both saw the lock free: last writer wins, the other retries", async () => {
    // Tab B read the lock before tab A's write became visible to it (cross-process race).
    const shared = memoryStorage();
    let staleReads = 1;
    const storageB = {
      getItem: (k) => (staleReads-- > 0 ? null : shared.getItem(k)),
      setItem: shared.setItem,
      removeItem: shared.removeItem,
    };
    const time = fakeTime(0);
    let holders = 0;
    let maxHolders = 0;
    const order = [];
    const work = (owner) => async () => {
      holders++;
      maxHolders = Math.max(maxHolders, holders);
      order.push(owner);
      await time.sleep(100);
      holders--;
    };
    const a = core.withLock({ storage: shared, owner: "A", now: time.now, sleep: time.sleep }, work("A"));
    const b = core.withLock({ storage: storageB, owner: "B", now: time.now, sleep: time.sleep }, work("B"));
    await time.run();
    assert.equal((await a).locked, true);
    assert.equal((await b).locked, true);
    assert.equal(maxHolders, 1);
    assert.deepEqual(order, ["B", "A"]); // B overwrote A's claim during the settle wait
  });

  test("many tabs all eventually save exactly once, one at a time", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    let holders = 0;
    let maxHolders = 0;
    const done = [];
    const tabs = ["A", "B", "C", "D"].map((owner) =>
      core.withLock({ storage, owner, now: time.now, sleep: time.sleep, timeout: 20000 }, async () => {
        holders++;
        maxHolders = Math.max(maxHolders, holders);
        await time.sleep(200);
        holders--;
        done.push(owner);
      })
    );
    await time.run();
    for (const t of tabs) assert.equal((await t).locked, true);
    assert.equal(maxHolders, 1);
    assert.deepEqual([...done].sort(), ["A", "B", "C", "D"]);
  });

  test("custom key and ttl", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    const p = core.acquireLock({ storage, owner: "A", key: "k", ttl: 100, now: time.now, sleep: time.sleep });
    await time.run();
    assert.equal(await p, true);
    assert.equal(JSON.parse(storage.getItem("k")).until, 100);
  });
});

describe("lock tokens", () => {
  test("a holder that outlived the ttl does not release the next holder's lock (same tab)", async () => {
    const storage = memoryStorage();
    const time = fakeTime(0);
    const opts = { storage, owner: "tabA", now: time.now, sleep: time.sleep };
    let second = null;
    let heldDuringSecond = null;
    const first = core.withLock(opts, async () => {
      await time.sleep(6000); // a slow save: the 5 s ttl runs out
      second = core.withLock(opts, async () => {
        await time.sleep(1000); // first releases meanwhile
        heldDuringSecond = storage.getItem("esp:lock") !== null;
      });
      await time.sleep(100); // the second holder has taken the expired lock
    });
    await time.run();
    await first;
    assert.equal((await second).locked, true);
    assert.equal(heldDuringSecond, true);
  });
});

describe("player sources", () => {
  test("streamSceneId reads the scene id from Stash stream URLs", () => {
    assert.equal(core.streamSceneId("http://h:9999/scene/12/stream"), "12");
    assert.equal(core.streamSceneId("http://h/base/scene/3/stream.webm?resolution=ORIGINAL"), "3");
    assert.equal(core.streamSceneId("blob:http://h/abc"), null);
    assert.equal(core.streamSceneId(""), null);
    assert.equal(core.streamSceneId(undefined), null);
  });

  test("sourceKey drops only the start parameter", () => {
    assert.equal(core.sourceKey("http://h/scene/1/stream.webm?resolution=ORIGINAL&start=12.5"), "http://h/scene/1/stream.webm?resolution=ORIGINAL");
    assert.equal(core.sourceKey("http://h/scene/1/stream.webm?start=3"), "http://h/scene/1/stream.webm");
    assert.equal(core.sourceKey("http://h/scene/1/stream?apikey=x"), "http://h/scene/1/stream?apikey=x");
    assert.equal(core.sourceKey(""), "");
  });
});

describe("keepaliveValue", () => {
  test("is max(known, last) + pending and never applies the deleted rule", () => {
    const last = core.encodeWatch(filled((i) => (i === 0 ? 10 : 0)));
    const pending = filled((i) => (i === 1 ? 5 : 0));
    const fromLast = core.decodeWatch(core.keepaliveValue(undefined, last, pending));
    assert.equal(fromLast[0], 10);
    assert.equal(fromLast[1], 5);
    const known = core.encodeWatch(filled((i) => (i === 0 ? 20 : 0)));
    const both = core.decodeWatch(core.keepaliveValue(known, last, pending));
    assert.equal(both[0], 20);
    assert.equal(both[1], 5);
  });
});
