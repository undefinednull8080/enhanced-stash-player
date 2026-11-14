import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../enhanced-stash-player/esp-core.js");
const graph = require("../enhanced-stash-player/esp-graph.js");

const N = core.BUCKETS;

function buckets(fn) {
  return Array.from({ length: N }, (_, i) => fn(i));
}

function pathPoints(d) {
  return [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe("graph model", () => {
  test("exports attach and model and sets globalThis.ESP.graph", () => {
    assert.equal(typeof graph.attach, "function");
    assert.equal(typeof graph.model, "function");
    assert.equal(globalThis.ESP.graph, graph);
  });

  test("no watch fields gives null", () => {
    assert.equal(graph.model({ customFields: {}, width: 500 }), null);
    assert.equal(graph.model({ customFields: { esp_start_at: 30, other: "x" }, width: 500 }), null);
    assert.equal(graph.model({ width: 500 }), null);
  });

  test("all-zero or invalid watch fields give null", () => {
    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(core.zeros()), esp_watch_bbbbbbbb: "garbage" };
    assert.equal(graph.model({ customFields: fields, width: 500 }), null);
  });

  test("zero or unknown width gives null", () => {
    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(buckets(() => 10)) };
    assert.equal(graph.model({ customFields: fields, width: 0 }), null);
    assert.equal(graph.model({ customFields: fields, width: NaN }), null);
  });

  test("path spans the width, peaks at full height, baseline at the bottom", () => {
    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(buckets((i) => (i < 100 ? 10 : 0))) };
    const m = graph.model({ customFields: fields, width: 400, height: 36 });
    const pts = pathPoints(m.path);
    assert.ok(m.path.endsWith("Z"));
    assert.deepEqual(pts[0], [0, 36]);
    assert.deepEqual(pts[pts.length - 1], [400, 36]);
    const ys = pts.map((p) => p[1]);
    assert.equal(Math.min(...ys), 0);
    assert.ok(ys.every((y) => y >= 0 && y <= 36));
    for (const [x] of pts) assert.ok(x >= 0 && x <= 400);
    // the unwatched second half sits on the baseline
    const tail = pts.filter(([x]) => x > 220 && x < 400);
    assert.ok(tail.length > 0 && tail.every(([, y]) => y === 36));
  });

  test("default height is 36", () => {
    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(buckets(() => 5)) };
    const m = graph.model({ customFields: fields, width: 200 });
    assert.deepEqual(pathPoints(m.path)[0], [0, 36]);
  });

  test("sums every esp_watch_* field before scaling", () => {
    const a = buckets((i) => (i === 50 ? 30 : 0));
    const b = buckets((i) => (i === 150 ? 20 : 0));
    const c = buckets((i) => (i === 150 ? 20 : 0));
    const fields = {
      esp_watch_aaaaaaaa: core.encodeWatch(a),
      esp_watch_bbbbbbbb: core.encodeWatch(b),
      esp_watch_cccccccc: core.encodeWatch(c),
    };
    const m = graph.model({ customFields: fields, width: 200, height: 36 });
    const pts = pathPoints(m.path);
    const yAt = (x) => pts.find((p) => p[0] === x)[1];
    // bucket 150 (40 summed) is the max; bucket 50 (30) is at 3/4 height
    assert.equal(yAt(150.5), 0);
    assert.equal(yAt(50.5), 9);
  });

  test("matches core smooth + scale + areaPath", () => {
    const raw = buckets((i) => (i * 7) % 23);
    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(raw) };
    const expected = core.areaPath(core.scaleHeights(core.smooth(core.decodeWatch(fields.esp_watch_aaaaaaaa), 5), 36), 640, 36);
    assert.equal(graph.model({ customFields: fields, width: 640, height: 36 }).path, expected);
  });

  test("tick sits at startAt / duration of the width", () => {
    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(buckets(() => 10)), esp_start_at: "30" };
    assert.equal(graph.model({ customFields: fields, width: 600, duration: 120, startAt: 30 }).tickX, 150);
    assert.equal(graph.model({ customFields: fields, width: 600, duration: 120, startAt: "60" }).tickX, 300);
    assert.equal(graph.model({ customFields: fields, width: 600, duration: 120, startAt: 0 }).tickX, 0);
  });

  test("no tick without a start, a duration, or past the end", () => {
    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(buckets(() => 10)) };
    const at = (startAt, duration) => graph.model({ customFields: fields, width: 600, duration, startAt }).tickX;
    assert.equal(at(null, 120), null);
    assert.equal(at(undefined, 120), null);
    assert.equal(at("", 120), null);
    assert.equal(at(true, 120), null);
    assert.equal(at(-5, 120), null);
    assert.equal(at(30, 0), null);
    assert.equal(at(30, undefined), null);
    assert.equal(at(200, 120), null);
  });
});

// ---- attach / detach with a tiny fake DOM ----

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function fakeEl(tag) {
  const el = {
    tag,
    attrs: {},
    style: {},
    children: [],
    parent: null,
    classes: new Set(),
    rect: rect(0, 0, 0, 0),
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "class") this.classes = new Set(String(v).split(/\s+/));
    },
    getAttribute(k) {
      return this.attrs[k];
    },
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    querySelector(sel) {
      return this.lookup[sel] || null;
    },
    lookup: {},
  };
  el.classList = {
    toggle(name, on) {
      if (on) el.classes.add(name);
      else el.classes.delete(name);
    },
    contains: (name) => el.classes.has(name),
  };
  return el;
}

function setup() {
  const frames = [];
  const observers = [];
  globalThis.document = { createElementNS: (ns, tag) => fakeEl(tag) };
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.ResizeObserver = class {
    constructor(fn) {
      this.fn = fn;
      this.targets = [];
      observers.push(this);
    }
    observe(t) {
      this.targets.push(t);
    }
    disconnect() {
      this.targets = [];
    }
  };

  const playerEl = fakeEl("div");
  const bar = fakeEl("div");
  const holder = fakeEl("div");
  playerEl.lookup[".vjs-control-bar"] = bar;
  bar.lookup[".vjs-progress-holder"] = holder;
  playerEl.appendChild(bar);
  bar.rect = rect(0, 400, 800, 90);
  holder.rect = rect(15, 440, 770, 4);

  const playerListeners = new Map();
  const player = {
    el: () => playerEl,
    on: (ev, fn) => playerListeners.set(ev, fn),
    off: (ev, fn) => playerListeners.get(ev) === fn && playerListeners.delete(ev),
  };

  const bus = new Map();
  const ctx = {
    core,
    player,
    active: true,
    customFields: {},
    getDuration: () => 100,
    on(ev, fn) {
      bus.set(ev, fn);
      return () => bus.delete(ev);
    },
    emit(ev, payload) {
      if (bus.has(ev)) bus.get(ev)(payload);
    },
  };
  const flush = () => frames.splice(0).forEach((fn) => fn());
  return { ctx, bar, holder, bus, playerListeners, observers, flush };
}

function cleanup() {
  delete globalThis.document;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
  delete globalThis.ResizeObserver;
}

describe("graph attach", () => {
  test("starts hidden without data, shows after saved, places above the holder", (t) => {
    t.after(cleanup);
    const env = setup();
    const detach = graph.attach(env.ctx);
    const svg = env.bar.children.find((c) => c.tag === "svg");
    assert.ok(svg);
    assert.ok(svg.classList.contains("esp-graph--empty"));

    const fields = { esp_watch_aaaaaaaa: core.encodeWatch(buckets(() => 10)), esp_start_at: 25 };
    env.ctx.customFields = fields;
    env.ctx.emit("saved", { field: "esp_watch_aaaaaaaa", value: fields.esp_watch_aaaaaaaa, customFields: fields });
    env.flush();
    assert.ok(!svg.classList.contains("esp-graph--empty"));
    assert.equal(svg.attrs.width, "770");
    assert.equal(svg.style.left, "15px");
    // bar bottom 490, holder centre 442, gap 5
    assert.equal(svg.style.bottom, "53px");
    const tick = svg.children.find((c) => c.tag === "rect");
    assert.equal(tick.style.display, "");
    assert.equal(Number(tick.attrs.x), 770 / 4 - 1);

    env.ctx.emit("startAtChanged", { startAt: null });
    env.flush();
    assert.equal(tick.style.display, "none");

    detach();
    assert.equal(env.bar.children.includes(svg), false);
    assert.equal(env.bus.size, 0);
    assert.equal(env.playerListeners.size, 0);
    assert.equal(env.observers[0].targets.length, 0);
  });

  test("no control bar means a no-op detach", (t) => {
    t.after(cleanup);
    const env = setup();
    env.ctx.player.el = () => null;
    const detach = graph.attach(env.ctx);
    assert.equal(typeof detach, "function");
    detach();
    assert.equal(env.bus.size, 0);
  });
});
