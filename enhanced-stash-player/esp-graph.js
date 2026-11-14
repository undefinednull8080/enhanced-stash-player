// Enhanced Stash Player: Watch graph above the seek bar.
(function (root) {
  "use strict";

  const ESP = (root.ESP = root.ESP || {});

  const HEIGHT = 36;
  const TICK_HEIGHT = 10;
  const TICK_WIDTH = 2;
  const GAP = 5; // px between the seek bar's centre line and the graph's baseline
  const SVG_NS = "http://www.w3.org/2000/svg";

  // Pure: what to draw for these fields at this size. null means draw nothing.
  function model(opts) {
    const core = ESP.core;
    const width = opts.width;
    const height = opts.height === undefined ? HEIGHT : opts.height;
    if (!(width > 0) || !(height > 0)) return null;
    const sums = core.sumWatchFields(opts.customFields || {});
    if (!core.hasCounts(sums)) return null;
    const heights = core.scaleHeights(core.smooth(sums, 5), height);
    return {
      path: core.areaPath(heights, width, height),
      tickX: tickPosition(opts.startAt, opts.duration, width),
    };
  }

  function tickPosition(startAt, duration, width) {
    const start = ESP.core.parseStartAt(startAt);
    if (start === null || !(duration > 0) || start > duration) return null;
    return Math.round((start / duration) * width * 100) / 100;
  }

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function attach(ctx) {
    const core = ctx.core;
    const playerEl = ctx.player.el();
    // Living inside the control bar lets video.js's own rules (user-inactive while playing,
    // controls disabled, native controls) fade and hide the graph together with the controls.
    const bar = playerEl && playerEl.querySelector(".vjs-control-bar");
    const holder = bar && bar.querySelector(".vjs-progress-holder");
    if (!bar || !holder) return function detach() {};

    let startAt = ctx.customFields[core.START_FIELD];
    let frame = 0;

    const svg = svgEl("svg", { class: "esp-graph esp-graph--empty", height: HEIGHT, "aria-hidden": "true" });
    const area = svgEl("path", { class: "esp-graph-area" });
    const tick = svgEl("rect", { class: "esp-graph-tick", width: TICK_WIDTH, height: TICK_HEIGHT });
    svg.appendChild(area);
    svg.appendChild(tick);
    bar.appendChild(svg);

    function render() {
      frame = 0;
      if (!ctx.active) return;
      const barRect = bar.getBoundingClientRect();
      const holderRect = holder.getBoundingClientRect();
      const width = Math.round(holderRect.width);
      const m = model({
        customFields: ctx.customFields,
        width,
        height: HEIGHT,
        duration: ctx.getDuration(),
        startAt,
      });
      svg.classList.toggle("esp-graph--empty", !m);
      if (!m) return;
      // Anchor to the holder's centre line: the holder grows on hover and its top edge moves.
      const centre = holderRect.top + holderRect.height / 2;
      svg.style.left = holderRect.left - barRect.left + "px";
      svg.style.bottom = barRect.bottom - centre + GAP + "px";
      svg.setAttribute("width", width);
      svg.setAttribute("viewBox", "0 0 " + width + " " + HEIGHT);
      area.setAttribute("d", m.path);
      if (m.tickX === null) {
        tick.style.display = "none";
      } else {
        tick.style.display = "";
        tick.setAttribute("x", Math.max(0, Math.min(width - TICK_WIDTH, m.tickX - TICK_WIDTH / 2)));
        tick.setAttribute("y", HEIGHT - TICK_HEIGHT);
      }
    }

    function schedule() {
      if (!frame) frame = requestAnimationFrame(render);
    }

    function onFields(payload) {
      const fields = (payload && payload.customFields) || ctx.customFields;
      startAt = fields[core.START_FIELD];
      schedule();
    }

    function onStartAt(payload) {
      startAt = payload ? payload.startAt : null;
      schedule();
    }

    const offs = [
      ctx.on("saved", onFields),
      ctx.on("fieldsChanged", onFields),
      ctx.on("startAtChanged", onStartAt),
    ];
    const playerEvents = ["durationchange", "loadedmetadata"];
    for (const ev of playerEvents) ctx.player.on(ev, schedule);

    let observer = null;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver(schedule);
      observer.observe(bar);
      observer.observe(holder);
    } else {
      root.addEventListener("resize", schedule);
    }

    render();

    return function detach() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      for (const off of offs) off();
      try {
        for (const ev of playerEvents) ctx.player.off(ev, schedule);
      } catch (e) {
        // the player may already be disposed
      }
      if (observer) observer.disconnect();
      else root.removeEventListener("resize", schedule);
      svg.remove();
    };
  }

  ESP.graph = { attach, model };
  if (typeof module !== "undefined" && module.exports) module.exports = ESP.graph;
})(typeof window !== "undefined" ? window : globalThis);
