import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../enhanced-stash-player/esp-core.js");
const tracker = require("../enhanced-stash-player/esp-tracker.js");

const SCENE = "7";
const BROWSER = "brow0001";
const FIELD = "esp_watch_" + BROWSER;
const DURATION = 200; // 1 s per bucket, so a 1 s step adds 10 tenths to one bucket

// ---- fakes ----

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (map.set(k, String(v)), true),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

// Virtual clock: sleep() resolves in time order when run() drives it, so concurrent tasks interleave.
function fakeClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = [];
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    sleep: (ms) => new Promise((resolve) => timers.push({ at: t + ms, seq: seq++, resolve })),
    async run(promise) {
      let done = false;
      promise.then(
        () => (done = true),
        () => (done = true),
      );
      for (;;) {
        await tick();
        if (done) return promise;
        if (!timers.length) throw new Error("deadlock: nothing scheduled");
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
    },
  };
}

// One Stash scene's custom fields, with latency on every request.
function fakeServer(clock, latency = 20) {
  const server = { fields: {}, reads: 0, writes: [], failWrites: false };
  server.read = async () => {
    server.reads++;
    await clock.sleep(latency);
    return { ...server.fields };
  };
  server.write = async (change, options) => {
    server.writes.push({ change, options });
    await clock.sleep(latency);
    if (server.failWrites) throw new Error("HTTP 500");
    for (const [k, v] of Object.entries(change.partial || {})) server.fields[k] = v;
    for (const k of change.remove || []) delete server.fields[k];
    return { ...server.fields };
  };
  return server;
}

function makeTab(env, tabId, extra = {}) {
  const saved = [];
  const session = tracker.createSession({
    sceneId: SCENE,
    tabId,
    browserId: BROWSER,
    storage: env.storage,
    now: env.clock.now,
    sleep: env.clock.sleep,
    readFields: env.server.read,
    writeFields: env.server.write,
    knownFields: () => env.server.fields,
    onSaved: (p) => saved.push(p),
    ...extra,
  });
  return { session, saved };
}

function env() {
  const clock = fakeClock();
  return { clock, storage: fakeStorage(), server: fakeServer(clock) };
}

function serverBuckets(e) {
  return core.decodeWatch(e.server.fields[FIELD]);
}

// Plays [from, to) in 1 s steps.
function play(session, from, to) {
  for (let t = from; t < to; t++) session.addStep(DURATION, t, t + 1);
}

function expected(ranges) {
  const b = core.zeros();
  for (const [from, to, times = 1] of ranges) for (let i = from; i < to; i++) b[i] += 10 * times;
  return b;
}

const pendingKey = (tab) => core.keys.pending(SCENE, tab);

// ---- save procedure ----

describe("save", () => {
  test("writes pending counts, stores esp:last, clears pending, reports the buckets", async () => {
    const e = env();
    const { session, saved } = makeTab(e, "tab00001");
    play(session, 0, 3);
    const result = await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 3]]));
    assert.equal(e.storage.getItem(core.keys.last(SCENE)), e.server.fields[FIELD]);
    assert.equal(core.hasCounts(session.pending), false);
    assert.equal(e.storage.getItem(pendingKey("tab00001")), null);
    assert.equal(e.storage.getItem(core.keys.lock), null, "lock released");
    assert.equal(saved.length, 1);
    assert.equal(result, saved[0]);
    assert.equal(result.field, FIELD);
    assert.equal(result.value, e.server.fields[FIELD]);
    assert.deepEqual(result.buckets, expected([[0, 3]]));
    assert.equal(result.customFields[FIELD], result.value);
  });

  test("adds to the existing value on every save", async () => {
    const e = env();
    const { session } = makeTab(e, "tab00001");
    play(session, 0, 2);
    await e.clock.run(session.save());
    play(session, 1, 4);
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2], [1, 4]]));
    assert.equal(e.server.writes.length, 2);
  });

  test("skips empty saves without reading or writing", async () => {
    const e = env();
    const { session, saved } = makeTab(e, "tab00001");
    assert.equal(await e.clock.run(session.save()), null);
    assert.equal(e.server.reads, 0);
    assert.equal(e.server.writes.length, 0);
    assert.equal(saved.length, 0);
  });

  test("keeps fractions below one tenth pending instead of rounding them away", async () => {
    const e = env();
    const { session } = makeTab(e, "tab00001");
    for (let i = 0; i < 4; i++) session.addStep(DURATION, i * 0.02, (i + 1) * 0.02); // 0.8 tenths
    await e.clock.run(session.save());
    assert.equal(e.server.writes.length, 0);
    for (let i = 4; i < 10; i++) session.addStep(DURATION, i * 0.02, (i + 1) * 0.02); // now 2 tenths
    await e.clock.run(session.save());
    assert.equal(serverBuckets(e)[0], 2);
  });

  test("ignores other browsers' fields and keeps them", async () => {
    const e = env();
    e.server.fields.esp_watch_other123 = core.encodeWatch(expected([[0, 10]]));
    const { session } = makeTab(e, "tab00001");
    play(session, 0, 1);
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 1]]));
    assert.ok(e.server.fields.esp_watch_other123);
  });

  test("Q29: base is max(server, esp:last) when the edit form restored an older value", async () => {
    const e = env();
    e.server.fields[FIELD] = core.encodeWatch(expected([[0, 2]]));
    e.storage.setItem(core.keys.last(SCENE), core.encodeWatch(expected([[0, 2], [5, 6]])));
    const { session } = makeTab(e, "tab00001");
    play(session, 9, 10);
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2], [5, 6], [9, 10]]));
  });

  test("Q29: a deleted field restarts from zero", async () => {
    const e = env();
    e.storage.setItem(core.keys.last(SCENE), core.encodeWatch(expected([[0, 50]])));
    const { session } = makeTab(e, "tab00001");
    play(session, 9, 10);
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[9, 10]]));
    assert.equal(e.storage.getItem(core.keys.last(SCENE)), e.server.fields[FIELD]);
  });

  test("a held lock keeps the counts pending in localStorage", async () => {
    const e = env();
    e.storage.setItem(core.keys.lock, JSON.stringify({ owner: "other", until: e.clock.now() + 60000 }));
    const { session } = makeTab(e, "tab00001");
    play(session, 0, 2);
    assert.equal(await e.clock.run(session.save()), null);
    assert.equal(e.server.writes.length, 0);
    assert.deepEqual(core.parsePending(e.storage.getItem(pendingKey("tab00001"))).buckets, expected([[0, 2]]));
    e.storage.removeItem(core.keys.lock);
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2]]));
  });

  test("a failed write keeps everything pending and releases the lock", async () => {
    const e = env();
    const { session, saved } = makeTab(e, "tab00001");
    play(session, 0, 2);
    e.server.failWrites = true;
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await e.clock.run(session.save()), null);
    } finally {
      console.warn = warn;
    }
    assert.equal(saved.length, 0);
    assert.equal(e.storage.getItem(core.keys.lock), null);
    assert.equal(e.storage.getItem(core.keys.last(SCENE)), null);
    e.server.failWrites = false;
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2]]));
  });

  test("counts added while a save is on the wire stay pending", async () => {
    const e = env();
    const { session } = makeTab(e, "tab00001");
    play(session, 0, 1);
    const saving = session.save();
    const run = e.clock.run(saving);
    while (!e.server.writes.length) await new Promise((r) => setImmediate(r));
    play(session, 1, 2);
    await run;
    assert.deepEqual(serverBuckets(e), expected([[0, 1]]));
    assert.deepEqual(core.parsePending(e.storage.getItem(pendingKey("tab00001"))).buckets, expected([[1, 2]]));
  });
});

// ---- several tabs of one browser ----

describe("tabs", () => {
  test("two tabs saving concurrently lose nothing", async () => {
    const e = env();
    const a = makeTab(e, "tabaaaaa");
    const b = makeTab(e, "tabbbbbb");
    play(a.session, 0, 20);
    play(b.session, 10, 30);
    await e.clock.run(Promise.all([a.session.save(), b.session.save()]));
    assert.deepEqual(serverBuckets(e), expected([[0, 20], [10, 30]]));
    assert.equal(e.server.writes.length, 2);
    assert.equal(e.storage.getItem(core.keys.lock), null);
  });

  test("many concurrent rounds across three tabs add up exactly", async () => {
    const e = env();
    const tabs = ["tab1aaaa", "tab2bbbb", "tab3cccc"].map((id) => makeTab(e, id).session);
    for (let round = 0; round < 4; round++) {
      tabs.forEach((s, i) => play(s, i * 5, i * 5 + 10));
      await e.clock.run(Promise.all(tabs.map((s) => s.save())));
    }
    assert.deepEqual(serverBuckets(e), expected([[0, 10, 4], [5, 15, 4], [10, 20, 4]]));
  });

  test("without the lock the same race would lose counts (sanity check of the fake)", async () => {
    const e = env();
    const read = async () => e.server.read();
    const naive = async (counts) => {
      const fields = await read();
      const next = core.nextWatchValue(fields[FIELD], null, counts);
      await e.server.write({ partial: { [FIELD]: next.value } });
    };
    await e.clock.run(Promise.all([naive(expected([[0, 1]])), naive(expected([[5, 6]]))]));
    assert.notDeepEqual(serverBuckets(e), expected([[0, 1], [5, 6]]));
  });

  test("adopts a stale tab's pending entry and removes it", async () => {
    const e = env();
    e.storage.setItem(pendingKey("deadtab1"), core.serializePending(expected([[3, 5]]), e.clock.now() - 20000));
    e.storage.setItem(pendingKey("livetab1"), core.serializePending(expected([[7, 8]]), e.clock.now() - 1000));
    e.storage.setItem(core.keys.pending("99", "deadtab2"), core.serializePending(expected([[0, 1]]), 0));
    const { session } = makeTab(e, "tab00001");
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[3, 5]]));
    assert.equal(e.storage.getItem(pendingKey("deadtab1")), null);
    assert.ok(e.storage.getItem(pendingKey("livetab1")), "fresh entry is left alone");
    assert.ok(e.storage.getItem(core.keys.pending("99", "deadtab2")), "other scenes are left alone");
  });

  test("two tabs adopting the same stale entry count it once", async () => {
    const e = env();
    e.storage.setItem(pendingKey("deadtab1"), core.serializePending(expected([[3, 5]]), 0));
    const a = makeTab(e, "tabaaaaa");
    const b = makeTab(e, "tabbbbbb");
    await e.clock.run(Promise.all([a.session.save(), b.session.save()]));
    assert.deepEqual(serverBuckets(e), expected([[3, 5]]));
  });

  test("a throttled tab whose entry was adopted does not count it again", async () => {
    const e = env();
    const a = makeTab(e, "tabaaaaa");
    play(a.session, 0, 2);
    a.session.persist();
    e.clock.advance(20000); // a's heartbeat went stale
    const b = makeTab(e, "tabbbbbb");
    await e.clock.run(b.session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2]]));
    play(a.session, 2, 3);
    await e.clock.run(a.session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 3]]));
  });

  test("a failed adoption puts the entry back", async () => {
    const e = env();
    const text = core.serializePending(expected([[3, 5]]), 0);
    e.storage.setItem(pendingKey("deadtab1"), text);
    e.server.failWrites = true;
    const { session } = makeTab(e, "tab00001");
    const warn = console.warn;
    console.warn = () => {};
    try {
      await e.clock.run(session.save());
    } finally {
      console.warn = warn;
    }
    assert.equal(e.storage.getItem(pendingKey("deadtab1")), text);
  });

  test("a new session picks up its own tab's leftover entry", async () => {
    const e = env();
    e.storage.setItem(pendingKey("tab00001"), core.serializePending(expected([[1, 2]]), 0));
    const { session } = makeTab(e, "tab00001");
    await e.clock.run(session.save());
    assert.deepEqual(serverBuckets(e), expected([[1, 2]]));
    assert.equal(e.storage.getItem(pendingKey("tab00001")), null);
  });

  test("persist writes a heartbeat and removes the entry once empty", () => {
    const e = env();
    const { session } = makeTab(e, "tab00001");
    session.persist();
    assert.equal(e.storage.getItem(pendingKey("tab00001")), null);
    play(session, 0, 1);
    session.persist();
    const entry = core.parsePending(e.storage.getItem(pendingKey("tab00001")));
    assert.equal(entry.heartbeat, e.clock.now());
    assert.deepEqual(entry.buckets, expected([[0, 1]]));
  });

  test("nextStaleIn reports when a fresh foreign entry goes stale", () => {
    const e = env();
    const { session } = makeTab(e, "tab00001");
    assert.equal(session.nextStaleIn(), null);
    e.storage.setItem(pendingKey("other001"), core.serializePending(expected([[0, 1]]), e.clock.now() - 5000));
    assert.equal(session.nextStaleIn(), 10001);
  });
});

// ---- pagehide keepalive ----

describe("keepalive", () => {
  test("writes last + pending with keepalive and records the expected value", async () => {
    const e = env();
    const { session } = makeTab(e, "tab00001");
    play(session, 0, 2);
    await e.clock.run(session.save());
    play(session, 2, 4);
    assert.equal(session.saveKeepalive(), true);
    const write = e.server.writes.at(-1);
    assert.deepEqual(write.options, { keepalive: true });
    const value = write.change.partial[FIELD];
    assert.deepEqual(core.decodeWatch(value), expected([[0, 4]]));
    const inflight = JSON.parse(e.storage.getItem(core.keys.inflight(SCENE)));
    assert.equal(inflight.tab00001.v, value);
    assert.equal(core.hasCounts(session.pending), false);
    assert.equal(session.saveKeepalive(), false, "nothing left to send");
  });

  test("next load confirms a keepalive that landed without writing again", async () => {
    const e = env();
    const first = makeTab(e, "tab00001");
    play(first.session, 0, 2);
    first.session.saveKeepalive();
    await e.clock.run(e.clock.sleep(100)); // the keepalive request lands
    const writes = e.server.writes.length;
    const next = makeTab(e, "tab00002");
    await e.clock.run(next.session.save());
    assert.equal(e.server.writes.length, writes);
    assert.equal(e.storage.getItem(core.keys.inflight(SCENE)), null);
    assert.equal(e.storage.getItem(core.keys.last(SCENE)), e.server.fields[FIELD]);
    assert.deepEqual(serverBuckets(e), expected([[0, 2]]));
  });

  test("next load re-applies a keepalive that did not land, once it is stale", async () => {
    const e = env();
    e.server.failWrites = true;
    const first = makeTab(e, "tab00001");
    play(first.session, 0, 2);
    first.session.saveKeepalive();
    await e.clock.run(e.clock.sleep(100));
    e.server.failWrites = false;
    const next = makeTab(e, "tab00002");
    await e.clock.run(next.session.save());
    assert.equal(e.server.fields[FIELD], undefined, "too early to tell: wait");
    assert.ok(e.storage.getItem(core.keys.inflight(SCENE)));
    e.clock.advance(16000);
    await e.clock.run(next.session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2]]));
    assert.equal(e.storage.getItem(core.keys.inflight(SCENE)), null);
    await e.clock.run(next.session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2]]), "applied only once");
  });

  test("two tabs closing at once: the losing keepalive is re-applied", async () => {
    const e = env();
    const a = makeTab(e, "tabaaaaa");
    const b = makeTab(e, "tabbbbbb");
    play(a.session, 0, 2);
    play(b.session, 5, 6);
    a.session.saveKeepalive();
    b.session.saveKeepalive();
    await e.clock.run(e.clock.sleep(100)); // both land; b overwrote a
    assert.deepEqual(serverBuckets(e), expected([[5, 6]]));
    e.clock.advance(16000);
    const next = makeTab(e, "tabccccc");
    await e.clock.run(next.session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 2], [5, 6]]));
  });

  test("a tab that never saw its own field still writes esp:last + pending", async () => {
    const e = env();
    const a = makeTab(e, "tabaaaaa");
    // b loaded before a's first save, so its cached fields have no esp_watch field
    const b = makeTab(e, "tabbbbbb", { knownFields: () => ({}) });
    play(a.session, 0, 2);
    await e.clock.run(a.session.save());
    play(b.session, 5, 6);
    b.session.saveKeepalive();
    await e.clock.run(e.clock.sleep(100));
    assert.deepEqual(serverBuckets(e), expected([[0, 2], [5, 6]]));
  });

  test("a stale inflight record is dropped when the user deleted the field", async () => {
    const e = env();
    const first = makeTab(e, "tab00001");
    play(first.session, 0, 2);
    await e.clock.run(first.session.save()); // esp:last now exists
    play(first.session, 2, 4);
    first.session.saveKeepalive();
    await e.clock.run(e.clock.sleep(100)); // the keepalive lands
    delete e.server.fields[FIELD]; // the user deletes the field elsewhere
    e.clock.advance(16000);
    const writes = e.server.writes.length;
    const next = makeTab(e, "tab00002");
    await e.clock.run(next.session.save());
    assert.equal(e.server.writes.length, writes, "nothing to restore");
    assert.equal(e.server.fields[FIELD], undefined);
    assert.equal(e.storage.getItem(core.keys.inflight(SCENE)), null);
  });

  test("a normal save on the wire at pagehide is not counted twice", async () => {
    const e = env();
    const { session } = makeTab(e, "tab00001");
    play(session, 0, 2);
    const run = e.clock.run(session.save());
    // let the lock settle and the read finish, so the write is on the wire
    while (!e.server.writes.length) await new Promise((r) => setImmediate(r));
    play(session, 2, 3);
    session.saveKeepalive();
    // The keepalive is lost; only the normal save lands.
    e.server.writes.at(-1).change.partial[FIELD] = "dropped";
    await run;
    await e.clock.run(e.clock.sleep(100)); // the lost keepalive lands too
    e.server.fields[FIELD] = core.encodeWatch(expected([[0, 2]]));
    e.clock.advance(16000);
    const next = makeTab(e, "tab00002");
    await e.clock.run(next.session.save());
    assert.deepEqual(serverBuckets(e), expected([[0, 3]]));
  });
});

// ---- player wiring ----

function fakePlayer() {
  const handlers = {};
  const p = {
    time: 0,
    isPaused: false,
    rate: 1,
    isSeeking: false,
    disposed: false,
    on: (name, fn) => (handlers[name] = handlers[name] || []).push(fn),
    off: (name, fn) => (handlers[name] = (handlers[name] || []).filter((f) => f !== fn)),
    trigger: (name) => (handlers[name] || []).slice().forEach((fn) => fn()),
    count: () => Object.values(handlers).reduce((n, list) => n + list.length, 0),
    currentTime: () => p.time,
    paused: () => p.isPaused,
    scrubbing: () => !!p.isScrubbing,
    playbackRate: () => p.rate,
    seeking: () => p.isSeeking,
    isDisposed: () => p.disposed,
  };
  p.tick = (t) => {
    p.time = t;
    p.trigger("timeupdate");
  };
  return p;
}

function fakeCtx(storage) {
  const bus = {};
  const ctx = {
    sceneId: SCENE,
    player: fakePlayer(),
    settings: core.normalizeSettings({}),
    tabId: "tabplay1",
    browserId: BROWSER,
    storage,
    storageOk: true,
    core,
    customFields: {},
    active: true,
    getDuration: () => DURATION,
    fields: {},
    writes: [],
    events: [],
  };
  ctx.readCustomFields = async () => (ctx.customFields = { ...ctx.fields });
  ctx.updateCustomFields = async (change, options) => {
    ctx.writes.push({ change, options });
    Object.assign(ctx.fields, change.partial);
    return (ctx.customFields = { ...ctx.fields });
  };
  ctx.on = (name, fn) => {
    (bus[name] = bus[name] || []).push(fn);
    return () => (bus[name] = bus[name].filter((f) => f !== fn));
  };
  ctx.emit = (name, payload) => {
    ctx.events.push([name, payload]);
    (bus[name] || []).forEach((fn) => fn(payload));
  };
  ctx.listeners = () => Object.values(bus).reduce((n, list) => n + list.length, 0);
  return ctx;
}

async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("attach", () => {
  const detaches = [];
  const docTarget = new EventTarget();
  const winTarget = new EventTarget();
  globalThis.document = Object.assign(docTarget, { visibilityState: "visible" });
  globalThis.addEventListener = winTarget.addEventListener.bind(winTarget);
  globalThis.removeEventListener = winTarget.removeEventListener.bind(winTarget);

  function start(ctx) {
    const detach = tracker.attach(ctx);
    detaches.push(detach);
    return detach;
  }

  afterEach(() => {
    while (detaches.length) detaches.pop()();
    document.visibilityState = "visible";
  });

  test("counts normal-speed playback and saves on pause with a 'saved' event", async () => {
    const ctx = fakeCtx(fakeStorage());
    start(ctx);
    const p = ctx.player;
    for (let t = 0; t <= 3; t += 0.25) p.tick(t);
    p.isPaused = true;
    p.trigger("pause");
    await waitFor(() => ctx.writes.length === 1);
    assert.deepEqual(core.decodeWatch(ctx.fields[FIELD]), expected([[0, 3]]));
    await waitFor(() => ctx.events.some(([n]) => n === "saved"));
    const [, payload] = ctx.events.find(([n]) => n === "saved");
    assert.equal(payload.field, FIELD);
    assert.deepEqual(payload.buckets, expected([[0, 3]]));
  });

  test("a pause that is part of a seek does not save", async () => {
    const ctx = fakeCtx(fakeStorage());
    start(ctx);
    await new Promise((r) => setTimeout(r, 50)); // the on-load save finds nothing to do
    const p = ctx.player;
    for (let t = 0; t <= 3; t += 0.25) p.tick(t);
    // Stash transcode seek: synthetic pause, then seeking, then playing again
    p.isPaused = true;
    p.trigger("pause");
    p.trigger("seeking");
    p.isPaused = false;
    p.trigger("playing");
    // seek bar mousedown: pause while scrubbing
    p.isScrubbing = true;
    p.isPaused = true;
    p.trigger("pause");
    p.isScrubbing = false;
    p.isPaused = false;
    p.trigger("playing");
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(ctx.writes.length, 0);
    p.isPaused = true;
    p.trigger("pause");
    await waitFor(() => ctx.writes.length === 1);
  });

  test("does not count seeks, other speeds, paused time or time around our own seeks", async () => {
    const ctx = fakeCtx(fakeStorage());
    start(ctx);
    const p = ctx.player;
    p.tick(0);
    p.tick(1); // counted: bucket 0
    p.tick(10); // seek by jump
    p.rate = 2;
    p.tick(10.5);
    p.rate = 1;
    p.isSeeking = true;
    p.time = 20;
    p.trigger("seeking");
    p.tick(20.5);
    p.isSeeking = false;
    p.trigger("seeked");
    p.tick(21); // counted: half of bucket 20 (from 20.5)
    ctx.emit("ourSeek", { from: 21, to: 50 });
    p.tick(21.2); // stale update before the jump lands
    p.tick(50.1); // lands near the target: not counted
    p.tick(51.1); // counted: 50.1-51.1
    p.isPaused = true;
    p.tick(52);
    p.trigger("ended");
    await waitFor(() => ctx.writes.length === 1);
    const b = core.decodeWatch(ctx.fields[FIELD]);
    const want = core.zeros();
    want[0] = 10;
    want[20] = 5;
    want[50] = 9;
    want[51] = 1;
    assert.deepEqual(b, want);
  });

  test("saves when the page is hidden and on detach; detach removes listeners", async () => {
    const ctx = fakeCtx(fakeStorage());
    const detach = start(ctx);
    const p = ctx.player;
    p.tick(0);
    p.tick(1);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => ctx.writes.length === 1);
    document.visibilityState = "visible";
    p.tick(2);
    detaches.pop();
    detach();
    assert.equal(p.count(), 0);
    assert.equal(ctx.listeners(), 0);
    await waitFor(() => ctx.writes.length === 2);
    assert.deepEqual(core.decodeWatch(ctx.fields[FIELD]), expected([[0, 2]]));
    p.tick(3);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ctx.writes.length, 2, "no more saves after detach");
  });

  test("pagehide sends a keepalive write", async () => {
    const ctx = fakeCtx(fakeStorage());
    start(ctx);
    ctx.player.tick(0);
    ctx.player.tick(1);
    winTarget.dispatchEvent(new Event("pagehide"));
    await waitFor(() => ctx.writes.length === 1);
    assert.deepEqual(ctx.writes[0].options, { keepalive: true });
    assert.ok(ctx.storage.getItem(core.keys.inflight(SCENE)));
  });

  test("does nothing when localStorage is unusable", () => {
    const ctx = fakeCtx(fakeStorage());
    ctx.storageOk = false;
    start(ctx);
    assert.equal(ctx.player.count(), 0);
    assert.equal(ctx.listeners(), 0);
  });
});
