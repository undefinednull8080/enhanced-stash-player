// Enhanced Stash Player: watch tracker: counting, pending buffer, lock, saving.
(function (root) {
  "use strict";

  const ESP = (root.ESP = root.ESP || {});
  const HEARTBEAT_MS = 5000;
  const OUR_SEEK_MAX_MS = 2000;
  const PAUSE_SAVE_DELAY_MS = 1000;
  const EPS = 1e-6;

  // ---- bucket helpers (local; candidates for ESP.core) ----

  // Whole tenths only: fractions stay pending so repeated small saves do not round counts away.
  function wholeTenths(buckets) {
    return buckets.map((v) => {
      const n = Math.floor((Number.isFinite(v) ? v : 0) + EPS);
      return n > 0 ? n : 0;
    });
  }

  function subtractInto(target, amount) {
    for (let i = 0; i < target.length; i++) target[i] = Math.max(0, target[i] - ((amount && amount[i]) || 0));
  }

  function addInto(target, amount) {
    for (let i = 0; i < target.length; i++) target[i] += (amount && amount[i]) || 0;
  }

  function covers(have, want) {
    for (let i = 0; i < want.length; i++) if ((have[i] || 0) < want[i]) return false;
    return true;
  }

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function countsOf(list) {
    const out = ESP.core.zeros();
    if (Array.isArray(list)) for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Number(list[i]) || 0);
    return out;
  }

  // ---- session: pending counts and the save procedure for one scene in one tab ----

  // o: {sceneId, tabId, browserId, storage, now?, sleep?, readFields() -> Promise<map>,
  //     writeFields(change, options?) -> Promise<map>, knownFields?() -> map, onSaved?(payload)}
  function createSession(o) {
    const core = ESP.core;
    const storage = o.storage;
    const now = o.now || Date.now;
    const field = core.watchFieldKey(o.browserId);
    const ownKey = core.keys.pending(o.sceneId, o.tabId);
    const prefix = core.keys.pendingPrefix(o.sceneId);
    const lastKey = core.keys.last(o.sceneId);
    const inflightKey = core.keys.inflight(o.sceneId);
    const lockOptions = { storage, owner: o.tabId, now, sleep: o.sleep };
    const pending = core.zeros();
    let persisted = null; // counts last written to ownKey, to detect adoption by another tab
    let persistedAt = 0;
    let sending = null; // {value, own} while a normal write is on the wire
    let keepaliveGen = 0;
    let queue = Promise.resolve();

    // A leftover entry from an earlier visit to this scene in this same tab.
    const leftover = core.parsePending(storage.getItem(ownKey));
    if (leftover) {
      addInto(pending, leftover.buckets);
      persisted = leftover.buckets;
    }

    // If another tab adopted (removed) our entry, those counts are its to save now.
    function syncOwn() {
      if (persisted && storage.getItem(ownKey) === null) {
        subtractInto(pending, persisted);
        persisted = null;
      }
    }

    function persist() {
      syncOwn();
      persistedAt = now();
      if (!core.hasCounts(wholeTenths(pending))) {
        if (persisted) storage.removeItem(ownKey);
        persisted = null;
        return;
      }
      const text = core.serializePending(pending, persistedAt);
      persisted = storage.setItem(ownKey, text) ? core.parsePending(text).buckets : null;
    }

    function addStep(duration, from, to) {
      const added = core.applyStep(pending, duration, from, to);
      // timeupdate keeps the heartbeat fresh even when a hidden tab's timers are throttled.
      if (added > 0 && now() - persistedAt >= HEARTBEAT_MS) persist();
      return added;
    }

    function readInflight() {
      const map = parseJson(storage.getItem(inflightKey));
      return map && typeof map === "object" && !Array.isArray(map) ? map : {};
    }

    function writeInflight(map) {
      if (Object.keys(map).length) storage.setItem(inflightKey, JSON.stringify(map));
      else storage.removeItem(inflightKey);
    }

    function foreignEntries() {
      const out = [];
      for (const key of storage.keys()) {
        if (key.indexOf(prefix) !== 0 || key === ownKey) continue;
        const text = storage.getItem(key);
        if (text !== null) out.push({ key, text, entry: core.parsePending(text) });
      }
      return out;
    }

    function staleForeign(t) {
      return foreignEntries().filter((e) => !e.entry || core.isStale(e.entry.heartbeat, t));
    }

    // Removes stale entries synchronously so no other tab can adopt them as well.
    function claimStale(t) {
      const claimed = staleForeign(t);
      for (const c of claimed) storage.removeItem(c.key);
      return claimed;
    }

    function restore(claimed) {
      for (const c of claimed) if (storage.getItem(c.key) === null) storage.setItem(c.key, c.text);
    }

    // Milliseconds until the next foreign entry or inflight record goes stale, or null.
    function nextStaleIn() {
      const t = now();
      let best = null;
      const consider = (heartbeat) => {
        if (!Number.isFinite(heartbeat) || core.isStale(heartbeat, t)) return;
        const wait = heartbeat + core.PENDING_STALE_MS - t + 1;
        if (best === null || wait < best) best = wait;
      };
      for (const e of foreignEntries()) if (e.entry) consider(e.entry.heartbeat);
      const inflight = readInflight();
      for (const tab of Object.keys(inflight)) consider(inflight[tab] && inflight[tab].t);
      return best;
    }

    function needsWork() {
      syncOwn();
      return (
        core.hasCounts(wholeTenths(pending)) ||
        staleForeign(now()).length > 0 ||
        Object.keys(readInflight()).length > 0
      );
    }

    function rememberWritten(buckets) {
      const last = core.decodeWatch(storage.getItem(lastKey));
      storage.setItem(lastKey, core.encodeWatch(core.maxBuckets(last, buckets)));
    }

    // Resolves pagehide keepalive writes: confirmed ones are dropped, failed (stale) ones
    // contribute their counts again. Returns {add, settled: [tabId]}.
    function settleInflight(server, t) {
      const add = core.zeros();
      const settled = [];
      const have = core.decodeWatch(server);
      const absent = server === undefined || server === null;
      // Q29: the field is gone although this browser wrote it before, so the user deleted it.
      const deleted = absent && storage.getItem(lastKey) !== null;
      const inflight = readInflight();
      for (const tab of Object.keys(inflight)) {
        const entry = inflight[tab] || {};
        const expected = core.decodeWatch(entry.v);
        if (!absent && covers(have, expected)) {
          rememberWritten(expected);
          settled.push(tab);
        } else if (deleted) {
          settled.push(tab);
        } else if (core.isStale(entry.t, t)) {
          const counts = countsOf(entry.c);
          // A normal save sent just before pagehide may have landed instead of the keepalive.
          if (entry.a && covers(have, core.decodeWatch(entry.a))) {
            rememberWritten(core.decodeWatch(entry.a));
            subtractInto(counts, countsOf(entry.ac));
          }
          addInto(add, wholeTenths(counts));
          settled.push(tab);
        }
      }
      return { add, settled };
    }

    function dropInflight(tabs) {
      if (!tabs.length) return;
      const map = readInflight();
      for (const tab of tabs) delete map[tab];
      writeInflight(map);
    }

    // Steps 2-4 of the save procedure; runs while holding esp:lock.
    async function saveLocked() {
      const fields = (await o.readFields()) || {};
      const server = fields[field];
      const t = now();
      const inflight = settleInflight(server, t);
      // Snapshot after the read, right before the write, so a pagehide in between is accounted for.
      syncOwn();
      const own = wholeTenths(pending);
      const claimed = claimStale(t);
      const add = core.addBuckets(own, inflight.add);
      for (const c of claimed) if (c.entry) addInto(add, wholeTenths(c.entry.buckets));

      if (!core.hasCounts(add)) {
        dropInflight(inflight.settled);
        return null;
      }
      const next = core.nextWatchValue(server, storage.getItem(lastKey), add);
      const gen = keepaliveGen;
      let updated;
      sending = { value: next.value, own };
      try {
        updated = await o.writeFields({ partial: { [field]: next.value } });
      } catch (e) {
        restore(claimed);
        throw e;
      } finally {
        sending = null;
      }
      storage.setItem(lastKey, next.value);
      dropInflight(inflight.settled);
      if (gen === keepaliveGen) subtractInto(pending, own);
      persist();
      return { field, value: next.value, buckets: next.buckets, customFields: updated || {} };
    }

    async function runSave() {
      if (!needsWork()) return null;
      const result = await core.withLock(lockOptions, saveLocked);
      if (!result.locked) {
        persist(); // counts stay pending in localStorage for the next save
        return null;
      }
      if (result.value && o.onSaved) o.onSaved(result.value);
      return result.value;
    }

    // Saves are chained: the lock blocks its own owner too, so overlapping saves must not race it.
    function save() {
      const run = queue.then(runSave).catch((e) => {
        console.warn("[ESP] could not save watch counts", e);
        persist();
        return null;
      });
      queue = run;
      return run;
    }

    // pagehide: no time to read or lock. Write last + pending with keepalive and remember what we
    // expect, so the next load can confirm it or re-apply the counts.
    function saveKeepalive() {
      syncOwn();
      const own = wholeTenths(pending);
      if (!core.hasCounts(own)) return false;
      const known = (o.knownFields && o.knownFields()) || {};
      const value = core.keepaliveValue(known[field], storage.getItem(lastKey), own);
      const record = { v: value, t: now(), c: own };
      if (sending) {
        record.a = sending.value;
        record.ac = sending.own;
      }
      const map = readInflight();
      map[o.tabId] = record;
      writeInflight(map);
      keepaliveGen++;
      subtractInto(pending, own);
      persist();
      try {
        Promise.resolve(o.writeFields({ partial: { [field]: value } }, { keepalive: true })).catch(() => {});
      } catch (e) {
        // the next load re-applies from the inflight record
      }
      return true;
    }

    return { field, pending, addStep, persist, save, saveKeepalive, nextStaleIn };
  }

  // ---- player wiring ----

  function attach(ctx) {
    // main already skips the tracker when disableTracking is set; this guards direct use.
    if (!ctx.storageOk || ctx.settings.disableTracking) return function detach() {};
    const core = ctx.core;
    const player = ctx.player;
    const doc = typeof document !== "undefined" ? document : null;
    const session = createSession({
      sceneId: ctx.sceneId,
      tabId: ctx.tabId,
      browserId: ctx.browserId,
      storage: ctx.storage,
      readFields: () => ctx.readCustomFields(),
      writeFields: (change, options) => ctx.updateCustomFields(change, options),
      knownFields: () => ctx.customFields,
      onSaved: (payload) => ctx.emit("saved", payload),
    });
    let lastTime = null;
    let ourSeek = null; // {to, at}: time around our own jump is not counted
    let adoptTimer = null;
    let pauseTimer = null;
    let detached = false;

    function onTimeUpdate() {
      const t = player.currentTime();
      const from = lastTime;
      lastTime = t;
      if (ourSeek) {
        if (Math.abs(t - ourSeek.to) <= core.MAX_STEP || Date.now() - ourSeek.at > OUR_SEEK_MAX_MS) ourSeek = null;
        return;
      }
      if (from === null || player.paused() || player.seeking() || player.playbackRate() !== 1) return;
      session.addStep(ctx.getDuration(), from, t);
    }

    function onSeeked() {
      lastTime = player.currentTime();
      ourSeek = null;
      // A seek while paused cancelled the pause save; start it again.
      if (player.paused()) onPause();
    }

    function onSourceChange() {
      lastTime = null;
    }

    function cancelPauseSave() {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }

    // Clicking the seek bar pauses until mouseup, and Stash's transcode seeks fire a synthetic
    // pause; neither is the viewer pausing, so wait a moment for `playing` or `seeking`.
    function onPause() {
      cancelPauseSave();
      if (typeof player.scrubbing === "function" && player.scrubbing()) return;
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        if (player.paused()) session.save();
      }, PAUSE_SAVE_DELAY_MS);
    }

    function onSeek() {
      cancelPauseSave();
      lastTime = player.currentTime();
    }

    function onEnded() {
      cancelPauseSave();
      session.save();
    }

    function onVisibility() {
      if (doc.visibilityState === "hidden") session.save();
    }

    function onPageHide() {
      session.saveKeepalive();
    }

    const playerEvents = [
      ["timeupdate", onTimeUpdate],
      ["seeking", onSeek],
      ["seeked", onSeeked],
      ["loadstart", onSourceChange],
      ["playing", cancelPauseSave],
      ["pause", onPause],
      ["ended", onEnded],
    ];
    for (const [name, fn] of playerEvents) player.on(name, fn);
    const offOurSeek = ctx.on("ourSeek", (e) => {
      lastTime = e.to;
      ourSeek = { to: e.to, at: Date.now() };
    });
    if (doc) doc.addEventListener("visibilitychange", onVisibility);
    if (typeof root.addEventListener === "function") root.addEventListener("pagehide", onPageHide);
    const heartbeat = setInterval(session.persist, HEARTBEAT_MS);

    // On load: confirm or re-apply keepalive writes and adopt stale tabs' counts. Retry once
    // when something is not stale yet (for example right after a reload).
    session.persist();
    session.save().then(() => {
      const wait = session.nextStaleIn();
      if (!detached && wait !== null) adoptTimer = setTimeout(session.save, wait);
    });

    return function detach() {
      detached = true;
      clearInterval(heartbeat);
      clearTimeout(adoptTimer);
      cancelPauseSave();
      offOurSeek();
      if (doc) doc.removeEventListener("visibilitychange", onVisibility);
      if (typeof root.removeEventListener === "function") root.removeEventListener("pagehide", onPageHide);
      if (!player.isDisposed()) for (const [name, fn] of playerEvents) player.off(name, fn);
      session.save();
    };
  }

  ESP.tracker = { attach, createSession };
  if (typeof module !== "undefined" && module.exports) module.exports = ESP.tracker;
})(typeof window !== "undefined" ? window : globalThis);
