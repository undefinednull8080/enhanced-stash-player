import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const pluginDir = new URL("../enhanced-stash-player/", import.meta.url);

// ---- minimal fakes: DOM, timers, video.js player, ctx ----

class FakeEl {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parent = null;
    this.listeners = {};
    this.classes = new Set();
    this.hidden = false;
    this.textContent = "";
    this.title = "";
    this._html = "";
    const el = this;
    this.classList = {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !el.classes.has(c) : force;
        if (on) el.classes.add(c);
        else el.classes.delete(c);
        return on;
      },
    };
  }
  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this.classes].join(" ");
  }
  set innerHTML(v) {
    this._html = v;
    this.childNodes = [];
    const m = /class="(vjs-control-text)"/.exec(v);
    if (m) {
      const span = new FakeEl("span");
      span.className = m[1];
      this.appendChild(span);
    }
  }
  get innerHTML() {
    return this._html;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  removeEventListener(ev, fn) {
    this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn);
  }
  dispatch(ev, props = {}) {
    const event = { type: ev, button: 0, defaultPrevented: false, stopped: false, ...props };
    event.preventDefault = () => (event.defaultPrevented = true);
    event.stopPropagation = () => (event.stopped = true);
    for (const fn of (this.listeners[ev] || []).slice()) fn(event);
    return event;
  }
  listenerCount() {
    return Object.values(this.listeners).reduce((n, list) => n + list.length, 0);
  }
  appendChild(child) {
    child.remove();
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child, ref) {
    child.remove();
    child.parent = this;
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, child);
    else this.childNodes.push(child);
    return child;
  }
  remove() {
    if (!this.parent) return;
    this.parent.childNodes = this.parent.childNodes.filter((c) => c !== this);
    this.parent = null;
  }
  querySelector(sel) {
    const cls = sel.replace(/^\./, "");
    for (const c of this.childNodes) {
      if (c.classes.has(cls)) return c;
      const found = c.querySelector(sel);
      if (found) return found;
    }
    return null;
  }
  find(cls) {
    return this.querySelector("." + cls);
  }
}

function fakeTimers() {
  let now = 1000;
  let nextId = 1;
  let timers = [];
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers = timers.filter((t) => t.id !== id);
    },
    advance(ms) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers = timers.filter((x) => x !== t);
        t.fn();
      }
    },
    pending: () => timers.length,
  };
}

function fakeComponent(el) {
  return {
    el: () => el,
    addClass: (c) => el.classList.add(c),
    disposed: false,
    dispose() {
      this.disposed = true;
      el.remove();
    },
  };
}

// A pointer target inside the progress control.
const seekBarTarget = { closest: (sel) => (sel.includes(".vjs-progress-control") ? {} : null) };

function fakePlayer({ time = 0, started = false, paused = true, controlBar = true, log = [] } = {}) {
  const el = new FakeEl("div");
  el.className = "video-js";
  const barEl = el.appendChild(new FakeEl("div"));
  barEl.className = "vjs-control-bar";
  const fullscreenEl = barEl.appendChild(new FakeEl("button"));
  fullscreenEl.className = "vjs-fullscreen-control";
  const fullscreen = fakeComponent(fullscreenEl);
  const listeners = {};
  const player = {
    log,
    time,
    started,
    isPaused: paused,
    disposed: false,
    src: "http://stash/scene/7/stream",
    el: () => el,
    currentSrc: () => player.src,
    currentTime(t) {
      if (t === undefined) return player.time;
      log.push(["currentTime", t]);
      player.time = t;
    },
    paused: () => player.isPaused,
    hasStarted: () => player.started,
    isDisposed: () => player.disposed,
    on(ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
    },
    off(ev, fn) {
      listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn);
    },
    trigger(ev) {
      for (const fn of (listeners[ev] || []).slice()) fn();
    },
    listenerCount: () => Object.values(listeners).reduce((n, l) => n + l.length, 0),
    play() {
      player.started = true;
      player.isPaused = false;
      player.trigger("playing");
    },
    seekByViewer(t) {
      el.dispatch("pointerdown", { target: seekBarTarget });
      player.time = t;
      player.trigger("seeking");
      player.trigger("seeked");
    },
    getChild: () => null,
  };
  if (controlBar) {
    const children = [fullscreen];
    const bar = {
      children: () => children.slice(),
      getChild: (name) => (name === "FullscreenToggle" ? fullscreen : null),
      addChild(name, options, index) {
        assert.equal(name, "Button");
        const bel = new FakeEl("button");
        bel.className = "vjs-control vjs-button";
        const placeholder = bel.appendChild(new FakeEl("span"));
        placeholder.className = "vjs-icon-placeholder";
        const comp = fakeComponent(bel);
        comp.text = "";
        comp.controlText = (t) => (comp.text = t);
        children.splice(index, 0, comp);
        barEl.insertBefore(bel, children[index + 1] ? children[index + 1].el() : null);
        return comp;
      },
      removeChild(comp) {
        children.splice(children.indexOf(comp), 1);
      },
    };
    player.bar = bar;
    player.getChild = (name) => (name === "ControlBar" ? bar : null);
  }
  return player;
}

function loadModule(timers, search = "") {
  const window = { location: { search } };
  const context = vm.createContext({
    window,
    globalThis: window,
    document: { createElement: (tag) => new FakeEl(tag) },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Date: { now: timers.now },
    console,
    btoa,
    atob,
    Promise,
  });
  window.window = window;
  for (const file of ["esp-core.js", "esp-starts-at.js"]) {
    vm.runInContext(readFileSync(new URL(file, pluginDir), "utf8"), context, { filename: file });
  }
  return window.ESP;
}

function setup({ fields = {}, settings = {}, player: playerOpts = {}, failUpdate = false, search = "" } = {}) {
  const timers = fakeTimers();
  const ESP = loadModule(timers, search);
  const log = [];
  const player = fakePlayer({ ...playerOpts, log });
  const bus = {};
  const toasts = [];
  const ctx = {
    sceneId: "7",
    player,
    core: ESP.core,
    settings: ESP.core.normalizeSettings(settings),
    customFields: fields,
    active: true,
    updates: [],
    on(ev, fn) {
      (bus[ev] = bus[ev] || []).push(fn);
      return () => (bus[ev] = bus[ev].filter((f) => f !== fn));
    },
    emit(ev, payload) {
      log.push([ev, plain(payload)]);
      for (const fn of bus[ev] || []) fn(payload);
    },
    toast(text, undo) {
      const t = { text, undo, removed: false };
      toasts.push(t);
      return () => (t.removed = true);
    },
    updateCustomFields(change) {
      ctx.updates.push(plain(change));
      if (failUpdate) return Promise.reject(new Error("nope"));
      const next = { ...ctx.customFields, ...(change.partial || {}) };
      for (const k of change.remove || []) delete next[k];
      ctx.customFields = next;
      ctx.emit("fieldsChanged", { customFields: next });
      return Promise.resolve(next);
    },
  };
  // The auto-jump decision runs one task after `playing`; run it right away here.
  const rawPlay = player.play;
  player.play = () => {
    rawPlay();
    timers.advance(0);
  };
  const detach = ESP.startsAt.attach(ctx);
  timers.advance(0);
  const flag = player.el().find("esp-flag");
  const skip = player.el().find("esp-skip-intro");
  return { ESP, ctx, player, log, toasts, timers, detach, flag, skip, bus };
}

// Values from the vm realm have other prototypes; compare plain copies.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const flush = () => new Promise((r) => setImmediate(r));
const seeks = (log) => log.filter((e) => e[0] === "currentTime").map((e) => e[1]);
const lastToast = (toasts) => toasts[toasts.length - 1];

// ---- pure logic ----

describe("startsAt.logic", () => {
  const { logic } = loadModule(fakeTimers()).startsAt;
  const core = loadModule(fakeTimers()).core;

  test("classifySeek: our own seek, matched by target", () => {
    const s = logic.newPlayState();
    s.ourSeekTo = 30;
    assert.equal(logic.classifySeek(s, 30.2, 0), "ours");
    s.playingSeen = true;
    assert.equal(logic.classifySeek(s, 50, 0), "viewer");
  });

  test("classifySeek: before the first playing only input makes it the viewer's", () => {
    const s = logic.newPlayState();
    assert.equal(logic.classifySeek(s, 120, 5000), "other");
    s.lastInputAt = 4500;
    assert.equal(logic.classifySeek(s, 120, 5000), "viewer");
    assert.equal(logic.classifySeek(s, 120, 5500), "viewer");
    assert.equal(logic.classifySeek(s, 120, 5501), "other");
  });

  test("firstPlayingJump only fires once per source", () => {
    const s = logic.newPlayState();
    const opts = { startAt: 30, currentTime: 0, leadIn: 5, disabled: false };
    assert.equal(logic.firstPlayingJump(s, core, opts), 25);
    assert.equal(logic.firstPlayingJump(s, core, opts), null);
    logic.resetPlayState(s);
    assert.equal(logic.firstPlayingJump(s, core, opts), 25);
  });

  test("firstPlayingJump respects viewer seeks, resume and the setting", () => {
    const fresh = () => logic.newPlayState();
    const base = { startAt: 30, currentTime: 0, leadIn: 0, disabled: false };
    const seeked = fresh();
    seeked.userSeeked = true;
    assert.equal(logic.firstPlayingJump(seeked, core, base), null);
    assert.equal(logic.firstPlayingJump(fresh(), core, { ...base, currentTime: 40 }), null);
    assert.equal(logic.firstPlayingJump(fresh(), core, { ...base, startAt: 60, currentTime: 15 }), null);
    assert.equal(logic.firstPlayingJump(fresh(), core, { ...base, disabled: true }), null);
    assert.equal(logic.firstPlayingJump(fresh(), core, { ...base, startAt: null }), null);
  });

  test("startValue rounds to tenths and never goes negative", () => {
    assert.equal(logic.startValue(83.456), 83.5);
    assert.equal(logic.startValue(-1), 0);
    assert.equal(logic.startValue(NaN), 0);
  });

  test("restoreChange", () => {
    assert.deepEqual(plain(logic.restoreChange("esp_start_at", null)), { remove: ["esp_start_at"] });
    assert.deepEqual(plain(logic.restoreChange("esp_start_at", 12)), { partial: { esp_start_at: 12 } });
  });
});

// ---- attach: auto-jump ----

describe("auto-jump", () => {
  test("first playing jumps to the start, emitting ourSeek before the seek", () => {
    const { player, log, toasts, skip } = setup({ fields: { esp_start_at: 83 } });
    player.play();
    const i = log.findIndex((e) => e[0] === "ourSeek");
    assert.deepEqual(log[i], ["ourSeek", { from: 0, to: 83 }]);
    assert.deepEqual(log[i + 1], ["currentTime", 83]);
    assert.equal(lastToast(toasts).text, "Skipped to 1:23");
    assert.equal(typeof lastToast(toasts).undo, "function");
    assert.equal(skip.hidden, true);
  });

  test("lead-in is subtracted, never below 0", () => {
    const a = setup({ fields: { esp_start_at: 30 }, settings: { leadIn: 5 } });
    a.player.play();
    assert.deepEqual(seeks(a.log), [25]);
    const b = setup({ fields: { esp_start_at: 3 }, settings: { leadIn: 10 }, player: { time: 0 } });
    b.player.play();
    assert.deepEqual(seeks(b.log), []);
  });

  test("a resume point past the start wins", () => {
    const { player, log } = setup({ fields: { esp_start_at: 10 }, player: { time: 12 } });
    player.play();
    assert.deepEqual(seeks(log), []);
  });

  test("no jump from 15 s or later", () => {
    const { player, log } = setup({ fields: { esp_start_at: 60 }, player: { time: 15 } });
    player.play();
    assert.deepEqual(seeks(log), []);
  });

  test("the setting turns it off but Skip intro still shows", () => {
    const { player, log, skip } = setup({ fields: { esp_start_at: 60 }, settings: { disableAutoJump: true } });
    player.play();
    assert.deepEqual(seeks(log), []);
    assert.equal(skip.hidden, false);
  });

  test("a viewer seek before playing wins", () => {
    const { player, log } = setup({ fields: { esp_start_at: 60 } });
    player.seekByViewer(5);
    player.play();
    assert.deepEqual(seeks(log), []);
  });

  test("a seek by Stash before playing (no input) does not block the jump", () => {
    const { player, log } = setup({ fields: { esp_start_at: 60 } });
    player.time = 4;
    player.trigger("seeking");
    player.play();
    assert.deepEqual(seeks(log), [60]);
  });

  test("only the first playing jumps; a new source starts over", () => {
    const { player, log } = setup({ fields: { esp_start_at: 60 } });
    player.play();
    player.trigger("seeking"); // our seek
    player.isPaused = true;
    player.seekByViewer(2);
    player.play();
    assert.deepEqual(seeks(log), [60]);
    player.time = 0;
    player.src = "http://stash/scene/8/stream";
    player.trigger("loadstart");
    player.play();
    assert.deepEqual(seeks(log), [60, 60]);
  });

  test("our own seek is not taken as the viewer's", () => {
    const { player, log } = setup({ fields: { esp_start_at: 60 } });
    player.play();
    player.trigger("seeking");
    player.time = 0;
    player.src = "http://stash/scene/8/stream";
    player.trigger("loadstart");
    player.play();
    assert.deepEqual(seeks(log), [60, 60]);
  });

  test("attaching while already playing counts as the first playing", () => {
    const { log } = setup({ fields: { esp_start_at: 60 }, player: { time: 1, started: true, paused: false } });
    assert.deepEqual(seeks(log), [60]);
  });

  test("Undo seeks back and brings Skip intro back", () => {
    const { player, log, toasts, skip } = setup({ fields: { esp_start_at: 60 }, player: { time: 1 } });
    player.play();
    lastToast(toasts).undo();
    assert.deepEqual(seeks(log), [60, 1]);
    assert.deepEqual(log.filter((e) => e[0] === "ourSeek").pop(), ["ourSeek", { from: 60, to: 1 }]);
    assert.equal(skip.hidden, false);
  });
});

describe("Stash behaviour around the first play", () => {
  test("a transcode reload (new ?start=) on the same scene does not start the rules over", () => {
    const { player, log, toasts } = setup({ fields: { esp_start_at: 60 }, player: { time: 1 } });
    player.src = "http://stash/scene/7/stream.webm?resolution=ORIGINAL";
    player.trigger("loadstart");
    player.play();
    assert.deepEqual(seeks(log), [60]);
    lastToast(toasts).undo();
    // Undo seeks outside the buffer: Stash reloads the source with ?start=1 and plays again.
    player.src = "http://stash/scene/7/stream.webm?resolution=ORIGINAL&start=1";
    player.trigger("seeking");
    player.trigger("loadstart");
    player.play();
    assert.deepEqual(seeks(log), [60, 1]);
    assert.equal(toasts.length, 1);
  });

  test("a click on play is not seek input, so the deferred resume seek does not block the jump", () => {
    const { player, log } = setup({ fields: { esp_start_at: 30 } });
    player.el().dispatch("pointerdown", { target: { closest: () => null } });
    player.time = 5; // resume seek, applied once metadata loads
    player.trigger("seeking");
    player.play();
    assert.deepEqual(seeks(log), [30]);
  });

  test("seek hotkeys count as input, other keys do not", () => {
    const { logic } = loadModule(fakeTimers()).startsAt;
    assert.equal(logic.isSeekInput({ type: "keydown", key: "ArrowRight" }), true);
    assert.equal(logic.isSeekInput({ type: "keydown", key: "5" }), true);
    assert.equal(logic.isSeekInput({ type: "keydown", key: " " }), false);
    assert.equal(logic.isSeekInput({ type: "pointerdown", target: seekBarTarget }), true);
    assert.equal(logic.isSeekInput({ type: "pointerdown", target: null }), false);
  });

  test("a marker click before playing (seek just after play resolves) wins over the jump", () => {
    const { player, log, toasts, skip, timers } = setup({ fields: { esp_start_at: 90 } });
    player.started = true;
    player.isPaused = false;
    player.trigger("playing");
    player.time = 30; // Stash: play().then(() => currentTime(30))
    timers.advance(0);
    assert.deepEqual(seeks(log), []);
    assert.equal(toasts.length, 0);
    player.trigger("timeupdate");
    assert.equal(skip.hidden, false);
  });

  test("a ?t= timestamp before the start is the viewer's choice", () => {
    const { player, log } = setup({ fields: { esp_start_at: 90 }, search: "?t=10" });
    player.time = 10;
    player.play();
    assert.deepEqual(seeks(log), []);
    const { logic } = loadModule(fakeTimers()).startsAt;
    assert.equal(logic.hasUrlTimestamp("?a=1&t=10"), true);
    assert.equal(logic.hasUrlTimestamp("?t=0"), false);
    assert.equal(logic.hasUrlTimestamp("?start=10"), false);
  });

  test("movedBySeek allows for playback during the wait", () => {
    const { logic } = loadModule(fakeTimers()).startsAt;
    assert.equal(logic.movedBySeek(0, 0.2, 0), false);
    assert.equal(logic.movedBySeek(0, 1.1, 1000), false);
    assert.equal(logic.movedBySeek(0, 30, 10), true);
    assert.equal(logic.movedBySeek(10, 0, 10), true);
  });
});

// ---- attach: Skip intro ----

describe("Skip intro", () => {
  test("shown only while before start - 2", () => {
    const { player, skip } = setup({ fields: { esp_start_at: 30 }, settings: { disableAutoJump: true } });
    assert.equal(skip.hidden, false);
    player.time = 28;
    player.trigger("timeupdate");
    assert.equal(skip.hidden, true);
    player.time = 27.9;
    player.trigger("timeupdate");
    assert.equal(skip.hidden, false);
  });

  test("hidden without a start", () => {
    const { skip } = setup();
    assert.equal(skip.hidden, true);
  });

  test("click jumps to the lead-in target and hides", () => {
    const { log, skip } = setup({ fields: { esp_start_at: 30 }, settings: { disableAutoJump: true, leadIn: 3 } });
    const ev = skip.dispatch("click");
    assert.equal(ev.stopped, true);
    assert.deepEqual(log.filter((e) => e[0] === "ourSeek").pop(), ["ourSeek", { from: 0, to: 27 }]);
    assert.deepEqual(seeks(log), [27]);
    assert.equal(skip.hidden, true);
  });

  test("comes back after a manual skip when the viewer returns to the intro", () => {
    const { player, skip } = setup({ fields: { esp_start_at: 30 }, settings: { disableAutoJump: true } });
    skip.dispatch("click");
    assert.equal(skip.hidden, true);
    player.seekByViewer(0);
    player.trigger("timeupdate");
    assert.equal(skip.hidden, false);
  });
});

// ---- attach: flag button ----

describe("flag button", () => {
  test("is inserted before the fullscreen toggle", () => {
    const { player, flag } = setup();
    const bar = player.el().find("vjs-control-bar");
    assert.equal(bar.childNodes.indexOf(flag), 0);
    assert.equal(bar.childNodes[1].classes.has("vjs-fullscreen-control"), true);
    assert.match(flag.find("vjs-icon-placeholder").innerHTML, /<svg/);
  });

  test("click saves the current time, emits startAtChanged, Undo removes it", async () => {
    const { ctx, player, flag, toasts, log } = setup({ player: { time: 83.46 } });
    flag.dispatch("click");
    await flush();
    assert.deepEqual(ctx.updates[0], { partial: { esp_start_at: 83.5 } });
    assert.equal(ctx.customFields.esp_start_at, 83.5);
    assert.deepEqual(log.filter((e) => e[0] === "startAtChanged").pop(), ["startAtChanged", { startAt: 83.5 }]);
    assert.equal(flag.classes.has("esp-flag--set"), true);
    assert.equal(lastToast(toasts).text, "Start set to 1:23");
    lastToast(toasts).undo();
    await flush();
    assert.deepEqual(ctx.updates[1], { remove: ["esp_start_at"] });
    assert.deepEqual(log.filter((e) => e[0] === "startAtChanged").pop(), ["startAtChanged", { startAt: null }]);
    assert.equal(flag.classes.has("esp-flag--set"), false);
    assert.equal(seeks(player.log).length, 0);
  });

  test("moving the start and undoing restores the previous value", async () => {
    const { ctx, flag, toasts } = setup({ fields: { esp_start_at: 10 }, player: { time: 40 } });
    flag.dispatch("click");
    await flush();
    lastToast(toasts).undo();
    await flush();
    assert.equal(ctx.customFields.esp_start_at, 10);
  });

  test("right-click clears, with Undo", async () => {
    const { ctx, flag, toasts } = setup({ fields: { esp_start_at: 10 } });
    const ev = flag.dispatch("contextmenu");
    assert.equal(ev.defaultPrevented, true);
    await flush();
    assert.deepEqual(ctx.updates[0], { remove: ["esp_start_at"] });
    assert.equal(lastToast(toasts).text, "Starts At cleared");
    lastToast(toasts).undo();
    await flush();
    assert.equal(ctx.customFields.esp_start_at, 10);
  });

  test("long-press clears and the click that ends it is ignored", async () => {
    const { ctx, flag, timers } = setup({ fields: { esp_start_at: 10 }, player: { time: 50 } });
    flag.dispatch("pointerdown");
    timers.advance(599);
    assert.equal(ctx.updates.length, 0);
    timers.advance(1);
    flag.dispatch("pointerup");
    flag.dispatch("click");
    await flush();
    assert.equal(ctx.updates.length, 1);
    assert.equal("esp_start_at" in ctx.customFields, false);
  });

  test("a short press is a normal click", async () => {
    const { ctx, flag, timers } = setup({ player: { time: 5 } });
    flag.dispatch("pointerdown");
    timers.advance(200);
    flag.dispatch("pointerup");
    flag.dispatch("click");
    timers.advance(1000);
    await flush();
    assert.equal(ctx.updates.length, 1);
    assert.equal(ctx.customFields.esp_start_at, 5);
  });

  test("clearing with nothing set does not save", async () => {
    const { ctx, flag, toasts } = setup();
    flag.dispatch("contextmenu");
    await flush();
    assert.equal(ctx.updates.length, 0);
    assert.equal(lastToast(toasts).undo, undefined);
  });

  test("a failed save shows a toast and emits nothing", async () => {
    const { flag, toasts, log } = setup({ failUpdate: true, player: { time: 5 } });
    const error = console.error;
    console.error = () => {};
    try {
      flag.dispatch("click");
      await flush();
    } finally {
      console.error = error;
    }
    assert.equal(lastToast(toasts).text, "Could not save Starts At");
    assert.equal(log.some((e) => e[0] === "startAtChanged"), false);
  });

  test("falls back to a plain button without a ControlBar component", () => {
    const { player, flag } = setup({ player: { controlBar: false } });
    const bar = player.el().find("vjs-control-bar");
    assert.equal(bar.childNodes.indexOf(flag), 0);
    assert.equal(flag.find("vjs-control-text").textContent, "Set Starts At here");
  });
});

// ---- detach ----

describe("detach", () => {
  test("removes listeners, DOM, toasts and timers", () => {
    const { player, flag, skip, toasts, timers, detach, bus } = setup({ fields: { esp_start_at: 60 } });
    player.play();
    flag.dispatch("pointerdown");
    detach();
    assert.equal(player.listenerCount(), 0);
    assert.equal(player.el().listenerCount(), 0);
    assert.equal(flag.listenerCount(), 0);
    assert.equal(skip.parent, null);
    assert.equal(flag.parent, null);
    assert.equal(player.bar.children().length, 1);
    assert.equal(toasts.every((t) => t.removed), true);
    assert.equal(timers.pending(), 0);
    assert.equal((bus.fieldsChanged || []).length, 0);
  });

  test("leaves a disposed player's control bar alone", () => {
    const { player, detach } = setup();
    player.disposed = true;
    detach();
    assert.equal(player.bar.children().length, 2);
  });
});
