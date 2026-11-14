// End-to-end: the plugin in a real Stash v0.31.1 scene page (see ../../docker-compose.yml).
import { test, expect } from "@playwright/test";
import { core, customFields, expectedTenths, gql, resetScene, sceneId, setFields, tenthsIn, watchFields } from "./stash.mjs";

let id;

test.beforeAll(async () => {
  id = await sceneId();
  expect(id, "scanned scene").toBeTruthy();
});

test.beforeEach(async () => {
  await resetScene(id);
});

// ---- page helpers ----

// Collects uncaught errors, console errors and failed requests so a test can assert there were none.
// Stash itself logs some on a bare library (404s for sprites/screenshots never generated, and a
// denied Screen Wake Lock in headless); those are left out.
const STASH_NOISE = [/Failed to obtain Screen Wake Lock/];
function watchConsole(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "warning" && text.includes("[ESP]")) errors.push(text);
    if (m.type() !== "error" || STASH_NOISE.some((re) => re.test(text))) return;
    // Resource errors are reported per URL below.
    if (!text.startsWith("Failed to load resource")) errors.push(text);
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    const ours = url.pathname.startsWith("/plugin/") || url.pathname === "/graphql";
    if (r.status() >= 400 && ours) errors.push(r.status() + " " + url.pathname);
  });
  return errors;
}

async function openScene(page) {
  await page.goto("/scenes/" + id);
  await page.waitForFunction(() => window.ESP && ESP.main && ESP.main.current() && document.querySelector(".esp-flag"));
}

function player(page, fn, arg) {
  return page.evaluate(
    ([src, a]) => new Function("p", "a", "return (" + src + ")(p, a)")(PluginApi.utils.InteractiveUtils.getPlayer(), a),
    [fn.toString(), arg]
  );
}

const currentTime = (page) => player(page, (p) => p.currentTime());

async function play(page) {
  await player(page, (p) => {
    p.muted(true);
    return p.play();
  });
  await page.waitForFunction(() => !PluginApi.utils.InteractiveUtils.getPlayer().paused());
}

async function playUntil(page, seconds) {
  await play(page);
  await page.waitForFunction(
    (s) => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() >= s,
    seconds,
    { timeout: 30000 }
  );
}

async function pause(page) {
  return player(page, (p) => {
    p.pause();
    return p.currentTime();
  });
}

async function pollFields(predicate, timeout = 15000) {
  let fields;
  await expect
    .poll(async () => predicate((fields = await customFields(id))), { timeout })
    .toBeTruthy();
  return fields;
}

function toast(page, text) {
  return page.locator(".esp-toast", { hasText: text });
}

// Played seconds [from, to) are counted within a tolerance: the first timeupdate only sets the
// start, and fractions below one tenth per bucket stay pending.
function expectCounted(fields, from, to) {
  const got = tenthsIn(fields, from, to);
  expect(got).toBeGreaterThan(expectedTenths(to - from - 1.2));
  expect(got).toBeLessThanOrEqual(expectedTenths(to - from + 0.6));
}

// ---- tests ----

test("plugin loads and plays a scene with no console errors", async ({ page }) => {
  const errors = watchConsole(page);
  const infos = [];
  page.on("console", (m) => {
    if (m.type() === "info" && m.text().startsWith("[ESP]")) infos.push(m.text());
  });
  await openScene(page);
  expect(infos).toContainEqual(expect.stringMatching(/^\[ESP\] Enhanced Stash Player \S+ loaded \(Stash v\d/));
  expect(infos).toContain("[ESP] attached to scene " + id);
  await expect(page.locator(".video-js .esp-flag")).toHaveCount(1);
  await expect(page.locator(".video-js .esp-skip-intro")).toBeHidden();
  await playUntil(page, 2);
  await pause(page);
  await pollFields((f) => watchFields(f).length === 1);
  expect(errors).toEqual([]);
});

test("the flag sets esp_start_at, and reload + play jumps there", async ({ page }) => {
  const errors = watchConsole(page);
  await openScene(page);
  const countedBefore = tenthsIn(await customFields(id), 0, 29.5);
  await playUntil(page, 0.5);
  await pause(page);
  await player(page, (p) => p.currentTime(30));
  await page.waitForFunction(() => Math.abs(PluginApi.utils.InteractiveUtils.getPlayer().currentTime() - 30) < 0.5);
  await page.locator(".esp-flag").click();
  await expect(toast(page, "Start set to 0:30")).toBeVisible();
  const fields = await pollFields((f) => f[core.START_FIELD] !== undefined);
  expect(fields[core.START_FIELD]).toBeCloseTo(30, 0);
  await expect(page.locator(".esp-flag")).toHaveClass(/esp-flag--set/);

  // The pause save waits a moment (a seek-bar click pauses too), so wait for it to land.
  const playedBefore = tenthsIn(await pollFields((f) => tenthsIn(f, 0, 29.5) > countedBefore), 0, 29.5);
  await page.reload();
  await page.waitForFunction(() => window.ESP && ESP.main && ESP.main.current() && document.querySelector(".esp-flag"));
  await expect(page.locator(".esp-skip-intro")).toBeVisible();
  await play(page);
  await expect(toast(page, "Skipped to 0:30")).toBeVisible();
  await page.waitForFunction(() => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() >= 31);
  await expect(page.locator(".esp-skip-intro")).toBeHidden();
  const at = await pause(page);
  // The jump itself (0 → 30) is never counted: only the 0.5 s played before setting the flag.
  const after = await pollFields((f) => tenthsIn(f, 30, 40) > 0);
  expect(tenthsIn(after, 0, 29.5)).toBe(playedBefore);
  expectCounted(after, 30, at);
  expect(errors).toEqual([]);
});

test("Undo on the auto-jump toast goes back and shows Skip intro", async ({ page }) => {
  await setFields(id, { [core.START_FIELD]: 40 });
  await openScene(page);
  await play(page);
  await page.waitForFunction(() => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() >= 40);
  await toast(page, "Skipped to 0:40").locator(".esp-toast-undo").click();
  await page.waitForFunction(() => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() < 10);
  await expect(page.locator(".esp-skip-intro")).toBeVisible();
  await page.locator(".esp-skip-intro").click();
  await page.waitForFunction(() => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() >= 40);
  await expect(page.locator(".esp-skip-intro")).toBeHidden();
});

test("play then pause writes esp_watch_<browserId>", async ({ page }) => {
  await openScene(page);
  const browserId = await page.evaluate(() => ESP.main.current().browserId);
  await playUntil(page, 5);
  const at = await pause(page);
  const fields = await pollFields((f) => f[core.watchFieldKey(browserId)] !== undefined);
  expect(watchFields(fields)).toEqual([core.watchFieldKey(browserId)]);
  expect(fields[core.watchFieldKey(browserId)]).toMatch(/^v1:/);
  expectCounted(fields, 0, at);
  expect(tenthsIn(fields, at + 1, 120)).toBe(0);
});

test("two pages on the same scene both counting: both counts are kept", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await openScene(a);
  await openScene(b);
  // Tab B plays a different range, so a lost save would show up as an empty range.
  await player(b, (p) => p.currentTime(60));
  await b.waitForFunction(() => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() >= 59.5);
  await Promise.all([play(a), play(b)]);
  await a.waitForFunction(() => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() >= 6, null, { timeout: 30000 });
  // Pause both at once, so their saves race for the lock.
  const [atA, atB] = await Promise.all([pause(a), pause(b)]);
  const fields = await pollFields((f) => tenthsIn(f, 0, 30) > 0 && tenthsIn(f, 60, 90) > 0);
  expect(watchFields(fields)).toHaveLength(1); // same browser, one field
  expectCounted(fields, 0, atA);
  expectCounted(fields, 60, atB);

  // Both tabs play the same range again: those counts add on top.
  const before = tenthsIn(fields, 0, 30);
  await player(b, (p) => p.currentTime(0));
  await Promise.all([play(a), play(b)]);
  await a.waitForFunction((t) => PluginApi.utils.InteractiveUtils.getPlayer().currentTime() >= t, atA + 3);
  await Promise.all([pause(a), pause(b)]);
  const again = await pollFields((f) => tenthsIn(f, 0, 30) > before + expectedTenths(4));
  expect(tenthsIn(again, 60, 90)).toBe(tenthsIn(fields, 60, 90));
});

test("the graph appears once data exists, with a tick at Starts At", async ({ page, browser }) => {
  await openScene(page);
  await expect(page.locator("svg.esp-graph")).toHaveCount(1);
  await expect(page.locator("svg.esp-graph")).toHaveClass(/esp-graph--empty/);

  // A save from this page redraws the graph without a reload.
  await playUntil(page, 3);
  await pause(page);
  await expect(page.locator("svg.esp-graph")).not.toHaveClass(/esp-graph--empty/);
  await expect(page.locator("svg.esp-graph path.esp-graph-area")).toHaveAttribute("d", /^M/);

  // Data from another browser plus a Starts At: shown on load.
  const other = core.zeros();
  for (let i = 100; i < 150; i++) other[i] = 30;
  await setFields(id, { esp_watch_e2eother: core.encodeWatch(other), [core.START_FIELD]: 60 });
  const second = await browser.newPage();
  await openScene(second);
  const graph = second.locator("svg.esp-graph");
  await expect(graph).not.toHaveClass(/esp-graph--empty/);
  await expect(graph.locator("rect.esp-graph-tick")).toBeAttached();
  const box = await graph.evaluate((svg) => {
    const g = svg.getBoundingClientRect();
    const h = document.querySelector(".vjs-progress-holder").getBoundingClientRect();
    const tick = svg.querySelector(".esp-graph-tick");
    return { gl: g.left, gw: g.width, hl: h.left, hw: h.width, gb: g.bottom, ht: h.top, tickX: Number(tick.getAttribute("x")), pe: getComputedStyle(svg).pointerEvents };
  });
  expect(Math.abs(box.gl - box.hl)).toBeLessThan(2);
  expect(Math.abs(box.gw - box.hw)).toBeLessThan(2);
  expect(box.gb).toBeLessThanOrEqual(box.ht + 1);
  expect(box.tickX / box.gw).toBeCloseTo(0.5, 1);
  expect(box.pe).toBe("none");
  await second.close();
});

test("closing the page mid-play lands the keepalive save", async ({ context }) => {
  const page = await context.newPage();
  // From pagehide on, log our GraphQL calls and fail any read, so only a write sent without reading
  // (the keepalive) can land. Chromium fires pagehide before visibilitychange on close.
  await page.addInitScript(() => {
    let unloading = false;
    window.addEventListener("pagehide", () => (unloading = true), true);
    const realFetch = window.fetch;
    window.fetch = function (url, init) {
      const body = (init && init.body) || "";
      if (unloading && /EspScene/.test(body)) {
        const op = /EspScene\w*/.exec(body)[0] + (init.keepalive ? ":keepalive" : "");
        localStorage.setItem("e2e:hidden-calls", (localStorage.getItem("e2e:hidden-calls") || "") + op + " ");
        if (op === "EspSceneFields") return Promise.reject(new Error("e2e: read blocked"));
      }
      return realFetch.apply(this, arguments);
    };
  });
  await openScene(page);
  const browserId = await page.evaluate(() => ESP.main.current().browserId);
  const field = core.watchFieldKey(browserId);
  await playUntil(page, 5);
  const at = await currentTime(page);
  await page.close({ runBeforeUnload: true });

  const fields = await pollFields((f) => f[field] !== undefined);
  expectCounted(fields, 0, at + 0.5);
  const stored = async () => {
    const origin = (await context.storageState()).origins.find((o) => o.origin === new URL(page.url()).origin);
    return Object.fromEntries(((origin && origin.localStorage) || []).map((e) => [e.name, e.value]));
  };
  const before = await stored();
  expect(before["e2e:hidden-calls"].trim().split(" ")).toEqual(["EspSceneUpdate:keepalive"]);
  expect(before["esp:inflight:" + id]).toBeTruthy();

  // The next load confirms the keepalive and does not add the counts again.
  const next = await context.newPage();
  await openScene(next);
  await expect.poll(async () => (await stored())["esp:inflight:" + id]).toBeUndefined();
  await next.waitForTimeout(1000);
  expect((await customFields(id))[field]).toBe(fields[field]);
});

test("leaving the scene inside the app saves the counts", async ({ page }) => {
  await openScene(page);
  const field = core.watchFieldKey(await page.evaluate(() => ESP.main.current().browserId));
  await playUntil(page, 3);
  const at = await currentTime(page);
  // A client-side route change (stash:location), not a page load.
  await page.locator('a[href="/scenes"]').first().click();
  await page.waitForFunction(() => !ESP.main.current());
  const fields = await pollFields((f) => f[field] !== undefined);
  expectCounted(fields, 0, at + 0.5);
});

test("plugin settings: disableAutoJump and disableTracking", async ({ page }) => {
  await setFields(id, { [core.START_FIELD]: 30 });
  await gql("mutation($i: Map!) { configurePlugin(plugin_id: \"enhanced-stash-player\", input: $i) }", {
    i: { disableAutoJump: true, disableTracking: true },
  });
  try {
    await openScene(page);
    expect(await page.evaluate(() => ESP.main.current().settings)).toEqual({
      disableAutoJump: true,
      leadIn: 0,
      hideGraph: false,
      disableTracking: true,
    });
    await playUntil(page, 3);
    await pause(page);
    expect(await currentTime(page)).toBeLessThan(10);
    await expect(page.locator(".esp-skip-intro")).toBeVisible();
    await page.waitForTimeout(1500);
    expect(watchFields(await customFields(id))).toEqual([]);
  } finally {
    await gql("mutation($i: Map!) { configurePlugin(plugin_id: \"enhanced-stash-player\", input: $i) }", { i: {} });
  }
});
