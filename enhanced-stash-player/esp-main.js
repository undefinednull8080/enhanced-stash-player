// Enhanced Stash Player: wiring. Loads last; attaches the feature modules to the scene player.
(function () {
  "use strict";

  const ESP = (window.ESP = window.ESP || {});
  const core = ESP.core;
  const SCENE_PATH = /^\/scenes\/(\d+)\/?$/;
  const PLAYER_POLL_MS = 100;
  const PLAYER_TIMEOUT_MS = 15000;
  const TOAST_MS = 6000;

  const SETTINGS_QUERY = "query EspSettings { configuration { plugins(include: [\"" + core.PLUGIN_ID + "\"]) } }";
  const VERSION_QUERY = "query EspVersion { version { version } }";
  const SCENE_QUERY = "query EspScene($id: ID!) { findScene(id: $id) { id custom_fields files { duration } } }";
  const FIELDS_QUERY = "query EspSceneFields($id: ID!) { findScene(id: $id) { id custom_fields } }";
  const UPDATE_MUTATION =
    "mutation EspSceneUpdate($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id custom_fields } }";

  const tabId = core.randomId(8);
  const storage = createStorage();
  let initPromise = null;
  let browserId = null;
  let activeSceneId = null; // scene we are attached to or attaching to
  let generation = 0; // bumped on every enter/leave so stale async work can bail
  let current = null; // { ctx, detaches, offDispose }

  // ---- shared helpers ----

  function graphqlUrl() {
    return new URL("graphql", document.baseURI).toString();
  }

  function gql(query, variables, options) {
    return fetch(graphqlUrl(), {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: variables || {} }),
      keepalive: !!(options && options.keepalive),
    })
      .then((res) => {
        if (!res.ok) throw new Error("GraphQL HTTP " + res.status);
        return res.json();
      })
      .then((body) => {
        if (body.errors && body.errors.length) throw new Error(body.errors.map((e) => e.message).join("; "));
        return body.data;
      });
  }

  // localStorage wrapper whose methods never throw (private windows, blocked storage).
  function createStorage() {
    let ls = null;
    try {
      ls = window.localStorage;
      const probe = "esp:probe";
      ls.setItem(probe, "1");
      ls.removeItem(probe);
    } catch (e) {
      ls = null;
    }
    return {
      ok: !!ls,
      getItem(key) {
        try {
          return ls ? ls.getItem(key) : null;
        } catch (e) {
          return null;
        }
      },
      setItem(key, value) {
        try {
          if (!ls) return false;
          ls.setItem(key, value);
          return true;
        } catch (e) {
          return false;
        }
      },
      removeItem(key) {
        try {
          if (ls) ls.removeItem(key);
        } catch (e) {
          // ignore
        }
      },
      keys() {
        try {
          return ls ? Object.keys(ls) : [];
        } catch (e) {
          return [];
        }
      },
    };
  }

  function getBrowserId() {
    if (browserId) return browserId;
    const stored = storage.getItem(core.keys.browserId);
    if (stored && /^[a-z0-9]{8}$/.test(stored)) {
      browserId = stored;
    } else {
      browserId = core.randomId(8);
      storage.setItem(core.keys.browserId, browserId);
    }
    return browserId;
  }

  function createBus() {
    let listeners = {};
    return {
      on(event, fn) {
        (listeners[event] = listeners[event] || []).push(fn);
        return () => {
          listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
        };
      },
      emit(event, payload) {
        for (const fn of (listeners[event] || []).slice()) {
          try {
            fn(payload);
          } catch (e) {
            console.error("[ESP] listener for " + event + " failed", e);
          }
        }
      },
      clear() {
        listeners = {};
      },
    };
  }

  function toastHost(player) {
    const parent = player && !player.isDisposed() ? player.el() : document.body;
    let host = parent.querySelector(":scope > .esp-toasts");
    if (!host) {
      host = document.createElement("div");
      host.className = "esp-toasts" + (parent === document.body ? " esp-toasts--page" : "");
      parent.appendChild(host);
    }
    return host;
  }

  function showToast(player, text, undoFn) {
    const el = document.createElement("div");
    el.className = "esp-toast";
    el.setAttribute("role", "status");
    const label = document.createElement("span");
    label.textContent = text;
    el.appendChild(label);
    const remove = () => el.remove();
    if (typeof undoFn === "function") {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "esp-toast-undo";
      undo.textContent = "Undo";
      undo.addEventListener("click", (e) => {
        e.stopPropagation();
        remove();
        undoFn();
      });
      el.appendChild(undo);
    }
    toastHost(player).appendChild(el);
    setTimeout(remove, TOAST_MS);
    return remove;
  }

  // ---- startup: settings + version, once per page load ----

  function loadSettings() {
    return gql(SETTINGS_QUERY)
      .then((data) => core.normalizeSettings(data.configuration.plugins[core.PLUGIN_ID]))
      .catch((e) => {
        console.warn("[ESP] could not load settings, using defaults", e);
        return core.normalizeSettings({});
      });
  }

  function checkVersion() {
    return gql(VERSION_QUERY)
      .then((data) => data.version.version)
      .catch(() => null)
      .then((version) => {
        if (core.isSupportedVersion(version)) return true;
        const msg = "Enhanced Stash Player needs Stash " + core.MIN_VERSION + " or newer (found " + version + ").";
        console.warn("[ESP] " + msg);
        showToast(null, msg);
        return false;
      });
  }

  function init() {
    if (!initPromise) {
      initPromise = Promise.all([checkVersion(), loadSettings()]).then(([ok, settings]) => (ok ? settings : null));
    }
    return initPromise;
  }

  // ---- player ----

  function findPlayer() {
    const utils = window.PluginApi && window.PluginApi.utils && window.PluginApi.utils.InteractiveUtils;
    const player = utils && utils.getPlayer ? utils.getPlayer() : undefined;
    return player && !player.isDisposed() ? player : null;
  }

  function waitForPlayer(gen) {
    return new Promise((resolve) => {
      const deadline = Date.now() + PLAYER_TIMEOUT_MS;
      const tick = () => {
        if (gen !== generation) return resolve(null);
        const player = findPlayer();
        if (player) return player.ready(() => resolve(player));
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, PLAYER_POLL_MS);
      };
      tick();
    });
  }

  // On a queue advance the route changes at once, but Stash keeps playing the previous scene in
  // the same player until its own scene query finishes. Wait until the source is this scene's,
  // so nothing is counted or jumped on the old video. A source that is not a Stash stream URL
  // cannot be checked and is accepted.
  function waitForSource(player, sceneId, gen) {
    return new Promise((resolve) => {
      const deadline = Date.now() + PLAYER_TIMEOUT_MS;
      let timer = null;
      const finish = (ok) => {
        clearTimeout(timer);
        if (!player.isDisposed()) player.off("loadstart", check);
        resolve(ok);
      };
      function check() {
        if (gen !== generation || player.isDisposed()) return finish(false);
        const src = player.currentSrc();
        const id = core.streamSceneId(src);
        if (id === sceneId || (src && id === null) || Date.now() > deadline) return finish(true);
        clearTimeout(timer);
        timer = setTimeout(check, PLAYER_POLL_MS);
      }
      player.on("loadstart", check);
      check();
    });
  }

  function fileDuration(scene) {
    const file = scene.files && scene.files[0];
    return file && file.duration > 0 ? file.duration : 0;
  }

  // ---- ctx ----

  function createCtx(sceneId, player, scene, settings) {
    const bus = createBus();
    const ctx = {
      sceneId,
      player,
      settings,
      tabId,
      browserId: getBrowserId(),
      storage,
      storageOk: storage.ok,
      core,
      duration: fileDuration(scene),
      customFields: scene.custom_fields || {},
      active: true,
      gql,
      on: bus.on,
      emit: bus.emit,
      clearBus: bus.clear,
    };

    ctx.getDuration = () => {
      if (ctx.duration > 0) return ctx.duration;
      const d = player.isDisposed() ? 0 : player.duration();
      return d > 0 && Number.isFinite(d) ? d : 0;
    };

    ctx.setCustomFields = (fields) => {
      ctx.customFields = fields || {};
      ctx.emit("fieldsChanged", { customFields: ctx.customFields });
      return ctx.customFields;
    };

    ctx.readCustomFields = () =>
      gql(FIELDS_QUERY, { id: sceneId }).then((data) => ctx.setCustomFields(data.findScene && data.findScene.custom_fields));

    ctx.updateCustomFields = (change, options) => {
      const fields = {};
      const partial = change && change.partial;
      const remove = change && change.remove;
      if (partial && Object.keys(partial).length) fields.partial = partial;
      if (remove && remove.length) fields.remove = remove;
      if (!fields.partial && !fields.remove) return Promise.resolve(ctx.customFields);
      const input = { id: sceneId, custom_fields: fields };
      return gql(UPDATE_MUTATION, { input }, options).then((data) => ctx.setCustomFields(data.sceneUpdate.custom_fields));
    };

    ctx.toast = (text, undoFn) => showToast(player, text, undoFn);
    return ctx;
  }

  // ---- scene enter / leave ----

  function attachModules(ctx) {
    const modules = [["startsAt", false]];
    modules.push(["tracker", ctx.settings.disableTracking]);
    modules.push(["graph", ctx.settings.hideGraph]);
    const detaches = [];
    for (const [name, skip] of modules) {
      const mod = ESP[name];
      if (skip || !mod || typeof mod.attach !== "function") continue;
      try {
        const detach = mod.attach(ctx);
        if (typeof detach === "function") detaches.push([name, detach]);
      } catch (e) {
        console.error("[ESP] " + name + ".attach failed", e);
      }
    }
    return detaches;
  }

  function leaveScene() {
    generation++;
    activeSceneId = null;
    if (!current) return;
    const { ctx, detaches, offDispose } = current;
    current = null;
    offDispose();
    for (const [name, detach] of detaches.slice().reverse()) {
      try {
        detach();
      } catch (e) {
        console.error("[ESP] " + name + " detach failed", e);
      }
    }
    ctx.active = false;
    ctx.clearBus();
  }

  async function enterScene(sceneId) {
    const gen = ++generation;
    activeSceneId = sceneId;
    const settings = await init();
    if (!settings || gen !== generation) return;
    const [player, data] = await Promise.all([
      waitForPlayer(gen),
      gql(SCENE_QUERY, { id: sceneId }).catch((e) => {
        console.error("[ESP] could not load scene " + sceneId, e);
        return null;
      }),
    ]);
    if (gen !== generation || !player || !data || !data.findScene) return;
    if (!(await waitForSource(player, sceneId, gen))) {
      // The player was rebuilt while we waited: start over with the new one.
      if (gen === generation) {
        leaveScene();
        handlePath(routerPath());
      }
      return;
    }

    const ctx = createCtx(sceneId, player, data.findScene, settings);
    // The player can be rebuilt while we stay on the page (e.g. a UI config change).
    const onDispose = () => {
      leaveScene();
      handlePath(routerPath());
    };
    player.one("dispose", onDispose);
    current = { ctx, detaches: attachModules(ctx), offDispose: () => player.off("dispose", onDispose) };
  }

  function sceneIdFromPath(pathname) {
    const m = SCENE_PATH.exec(pathname || "");
    return m ? m[1] : null;
  }

  function handlePath(pathname) {
    const sceneId = sceneIdFromPath(pathname);
    if (sceneId === activeSceneId) return;
    leaveScene();
    if (sceneId) enterScene(sceneId);
  }

  // window.location.pathname includes Stash's base path (reverse proxy prefix); the router's does not.
  function routerPath() {
    const base = new URL(document.baseURI).pathname;
    const path = window.location.pathname;
    return path.indexOf(base) === 0 ? "/" + path.slice(base.length) : path;
  }

  function start() {
    if (!window.PluginApi || !window.PluginApi.Event) {
      console.warn("[ESP] PluginApi not found; Enhanced Stash Player is inactive.");
      return;
    }
    window.PluginApi.Event.addEventListener("stash:location", (e) => {
      const loc = e.detail && e.detail.data && e.detail.data.location;
      handlePath(loc ? loc.pathname : routerPath());
    });
    handlePath(routerPath());
  }

  ESP.main = { tabId, storage, gql, handlePath, leaveScene, current: () => (current ? current.ctx : null) };
  start();
})();
