// Enhanced Stash Player: Starts At: flag button, auto-jump, Skip intro.
(function () {
  "use strict";

  const ESP = (window.ESP = window.ESP || {});

  const LONG_PRESS_MS = 600;
  // A seek this soon after a pointer or key press inside the player is the viewer's own.
  const INPUT_WINDOW_MS = 1000;
  // A `seeking` within this distance of the time we asked for is our own seek.
  const SEEK_MATCH = 0.5;
  // Only these controls seek. A click on play must not count: Stash's resume seek waits for
  // metadata and lands right after it.
  const SEEK_CONTROLS = ".vjs-progress-control, .vjs-seek-button, .vjs-marker, .vjs-marker-range";
  // Stash's seek hotkeys: arrows, 0-9 (percent) and [ ].
  const SEEK_KEYS = /^(ArrowLeft|ArrowRight|[0-9]|\[|\])$/;

  const FLAG_ICON =
    '<svg class="esp-flag-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path class="esp-flag-pole" d="M6 3h2v18H6z"/>' +
    '<path class="esp-flag-cloth" d="M8.5 4.5h10l-2.5 3.75 2.5 3.75h-10z"/>' +
    "</svg>";

  // ---- pure decisions (unit-tested in tests/starts-at.test.mjs) ----

  // urlSeek: the page was opened with a ?t= timestamp, which is the viewer's own choice.
  function newPlayState(urlSeek) {
    return {
      playingSeen: false,
      jumped: false,
      skippedTo: null,
      urlSeek: !!urlSeek,
      userSeeked: !!urlSeek,
      ourSeekTo: null,
      lastInputAt: -Infinity,
    };
  }

  // A new source (first load, queue advance) starts the auto-jump rules over.
  function resetPlayState(state) {
    state.playingSeen = false;
    state.jumped = false;
    state.skippedTo = null;
    state.userSeeked = state.urlSeek;
    state.ourSeekTo = null;
  }

  // True when the query string carries Stash's `t` timestamp (seconds > 0).
  function hasUrlTimestamp(search) {
    const m = /[?&]t=([^&]*)/.exec(search || "");
    return !!m && Number(decodeURIComponent(m[1])) > 0;
  }

  // Skip intro stays hidden after an auto-jump, and after a manual skip until the viewer goes
  // back before where it landed (a lead-in can land inside the margin).
  function skipHidden(state, time) {
    return state.jumped || (state.skippedTo !== null && time >= state.skippedTo - SEEK_MATCH);
  }

  function isSeekInput(event) {
    if (event.type === "keydown") return SEEK_KEYS.test(event.key || "");
    const target = event.target;
    return !!(target && typeof target.closest === "function" && target.closest(SEEK_CONTROLS));
  }

  // Playback moved further than the elapsed time allows: something seeked in between.
  function movedBySeek(from, to, elapsedMs) {
    const moved = to - from;
    return moved < -SEEK_MATCH || moved > elapsedMs / 1000 + SEEK_MATCH;
  }

  // "ours" | "viewer" | "other". Seeks before the first `playing` without viewer input come from
  // Stash itself (resume point, URL timestamp); the currentTime rule already lets those win.
  function classifySeek(state, time, now) {
    if (state.ourSeekTo !== null && Math.abs(time - state.ourSeekTo) <= SEEK_MATCH) return "ours";
    if (state.playingSeen || now - state.lastInputAt <= INPUT_WINDOW_MS) return "viewer";
    return "other";
  }

  // Target for the first `playing` of a source, or null. Marks the first playing as seen.
  function firstPlayingJump(state, core, opts) {
    if (state.playingSeen) return null;
    state.playingSeen = true;
    return core.autoJumpTarget({
      startAt: opts.startAt,
      currentTime: opts.currentTime,
      leadIn: opts.leadIn,
      userSeeked: state.userSeeked,
      disabled: opts.disabled,
    });
  }

  // The value stored when the flag is clicked at `time`: tenths of a second are plenty.
  function startValue(time) {
    return Math.max(0, Math.round((Number(time) || 0) * 10) / 10);
  }

  // The custom_fields change that restores `previous` (a number, or null for "not set").
  function restoreChange(field, previous) {
    if (previous === null || previous === undefined) return { remove: [field] };
    const partial = {};
    partial[field] = previous;
    return { partial };
  }

  // ---- attach ----

  function attach(ctx) {
    const core = ctx.core;
    const player = ctx.player;
    const field = core.START_FIELD;
    const state = newPlayState(hasUrlTimestamp(window.location && window.location.search));
    const cleanups = [];
    const toasts = [];
    let queue = Promise.resolve();

    function startAt() {
      return core.parseStartAt(ctx.customFields && ctx.customFields[field]);
    }

    function listen(target, event, fn) {
      target.addEventListener(event, fn);
      cleanups.push(() => target.removeEventListener(event, fn));
    }

    function onPlayer(event, fn) {
      player.on(event, fn);
      cleanups.push(() => player.off(event, fn));
    }

    function toast(text, undoFn) {
      const remove = ctx.toast(text, undoFn);
      toasts.push(remove);
      return remove;
    }

    function seekTo(to) {
      const from = player.currentTime();
      state.ourSeekTo = to;
      ctx.emit("ourSeek", { from, to });
      player.currentTime(to);
    }

    // ---- flag button ----

    function createFlagButton() {
      const bar = player.getChild && player.getChild("ControlBar");
      if (!bar || typeof bar.addChild !== "function") return createFallbackButton();
      const children = bar.children();
      const fullscreen = bar.getChild("FullscreenToggle");
      const index = fullscreen ? children.indexOf(fullscreen) : -1;
      const button = bar.addChild("Button", {}, index >= 0 ? index : children.length);
      button.addClass("esp-flag");
      const placeholder = button.el().querySelector(".vjs-icon-placeholder");
      if (placeholder) placeholder.innerHTML = FLAG_ICON;
      return {
        el: button.el(),
        setText: (text) => button.controlText(text),
        remove: () => {
          bar.removeChild(button);
          button.dispose();
        },
      };
    }

    // Without a ControlBar component, insert a plain button into the control bar element.
    function createFallbackButton() {
      const root = player.el();
      const bar = root.querySelector(".vjs-control-bar") || root;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "vjs-control vjs-button esp-flag";
      el.innerHTML = FLAG_ICON + '<span class="vjs-control-text" aria-live="polite"></span>';
      bar.insertBefore(el, bar.querySelector(".vjs-fullscreen-control"));
      return {
        el,
        setText: (text) => {
          el.title = text;
          el.querySelector(".vjs-control-text").textContent = text;
        },
        remove: () => el.remove(),
      };
    }

    const flag = createFlagButton();

    function renderFlag() {
      const s = startAt();
      flag.el.classList.toggle("esp-flag--set", s !== null);
      flag.setText(
        s === null
          ? "Set Starts At here"
          : "Starts At " + core.formatTime(s) + ". Click to move it here, long-press or right-click to clear"
      );
    }

    // Saves run one after another so a quick Undo cannot overtake the save it undoes.
    function change(fieldsChange) {
      const run = () =>
        ctx.updateCustomFields(fieldsChange).then(() => {
          if (!ctx.active) return;
          render();
          ctx.emit("startAtChanged", { startAt: startAt() });
        });
      queue = queue.then(run, run);
      return queue.catch((e) => {
        console.error("[ESP] could not save Starts At", e);
        if (ctx.active) toast("Could not save Starts At");
        throw e;
      });
    }

    function undoTo(previous) {
      return () => {
        change(restoreChange(field, previous)).catch(() => {});
      };
    }

    function setStart() {
      const previous = startAt();
      const value = startValue(player.currentTime());
      const partial = {};
      partial[field] = value;
      change({ partial })
        .then(() => {
          if (ctx.active) toast("Start set to " + core.formatTime(value), undoTo(previous));
        })
        .catch(() => {});
    }

    function clearStart() {
      const previous = startAt();
      if (previous === null) {
        toast("No Starts At to clear");
        return;
      }
      change({ remove: [field] })
        .then(() => {
          if (ctx.active) toast("Starts At cleared", undoTo(previous));
        })
        .catch(() => {});
    }

    let pressTimer = null;
    let longPressed = false;

    function cancelPress() {
      clearTimeout(pressTimer);
      pressTimer = null;
    }

    listen(flag.el, "pointerdown", (e) => {
      if (e.button !== 0) return;
      longPressed = false;
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        clearStart();
      }, LONG_PRESS_MS);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) listen(flag.el, ev, cancelPress);
    listen(flag.el, "click", (e) => {
      e.stopPropagation();
      // The click that ends a long-press must not set the start again.
      if (longPressed) {
        longPressed = false;
        return;
      }
      setStart();
    });
    listen(flag.el, "contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelPress();
      clearStart();
    });
    cleanups.push(cancelPress);

    // ---- Skip intro ----

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "esp-skip-intro";
    skip.textContent = "Skip intro";
    skip.hidden = true;
    player.el().appendChild(skip);
    listen(skip, "click", (e) => {
      e.stopPropagation();
      const s = startAt();
      if (s === null) return;
      // Not an auto-jump: the button comes back if the viewer returns to the intro.
      state.skippedTo = core.jumpTarget(s, ctx.settings.leadIn);
      seekTo(state.skippedTo);
      renderSkip();
    });

    function renderSkip() {
      const time = player.currentTime();
      skip.hidden = !core.shouldShowSkip({ startAt: startAt(), currentTime: time, jumped: skipHidden(state, time) });
    }

    function render() {
      renderFlag();
      renderSkip();
    }

    // ---- auto-jump ----

    let jumpTimer = null;

    function cancelJump() {
      clearTimeout(jumpTimer);
      jumpTimer = null;
    }
    cleanups.push(cancelJump);

    // Stash's marker and timestamp clicks call play() and seek once it resolves, which is just
    // after `playing`. Decide one task later so such a seek wins over the auto-jump.
    function onPlaying() {
      if (state.playingSeen || jumpTimer !== null) return;
      const seen = player.currentTime();
      const seenAt = Date.now();
      jumpTimer = setTimeout(() => {
        jumpTimer = null;
        decideJump(seen, seenAt);
      }, 0);
    }

    function decideJump(seen, seenAt) {
      if (!ctx.active || state.playingSeen) return;
      const from = player.currentTime();
      if (movedBySeek(seen, from, Date.now() - seenAt)) state.userSeeked = true;
      const to = firstPlayingJump(state, core, {
        startAt: startAt(),
        currentTime: from,
        leadIn: ctx.settings.leadIn,
        disabled: ctx.settings.disableAutoJump,
      });
      if (to === null) return;
      seekTo(to);
      state.jumped = true;
      renderSkip();
      toast("Skipped to " + core.formatTime(to), () => {
        if (!ctx.active) return;
        seekTo(from);
        state.jumped = false;
        renderSkip();
      });
    }

    function onSeeking() {
      const kind = classifySeek(state, player.currentTime(), Date.now());
      if (kind === "ours") state.ourSeekTo = null;
      else if (kind === "viewer") state.userSeeked = true;
      renderSkip();
    }

    function sourceNow() {
      return typeof player.currentSrc === "function" ? core.sourceKey(player.currentSrc()) : "";
    }

    // Stash's transcode streams reload with a new ?start= on every seek outside the buffer, which
    // fires loadstart for the same scene. Only a different source starts the rules over.
    let source = sourceNow();
    function onLoadStart() {
      const next = sourceNow();
      if (next === source) return;
      source = next;
      cancelJump();
      resetPlayState(state);
      renderSkip();
    }

    const markInput = (e) => {
      if (isSeekInput(e)) state.lastInputAt = Date.now();
    };
    listen(player.el(), "pointerdown", markInput);
    listen(player.el(), "keydown", markInput);
    onPlayer("playing", onPlaying);
    onPlayer("seeking", onSeeking);
    onPlayer("loadstart", onLoadStart);
    onPlayer("timeupdate", renderSkip);
    onPlayer("seeked", renderSkip);
    cleanups.push(ctx.on("fieldsChanged", render));

    render();
    // Autoplay can start before we attach; that playing counts as the first one.
    if (player.hasStarted() && !player.paused()) onPlaying();

    return function detach() {
      for (const fn of cleanups.splice(0).reverse()) fn();
      for (const remove of toasts.splice(0)) remove();
      skip.remove();
      // A disposed player has already disposed its control bar children.
      if (!player.isDisposed()) flag.remove();
    };
  }

  ESP.startsAt = {
    attach,
    logic: {
      newPlayState,
      resetPlayState,
      classifySeek,
      firstPlayingJump,
      startValue,
      restoreChange,
      hasUrlTimestamp,
      skipHidden,
      isSeekInput,
      movedBySeek,
    },
  };
})();
