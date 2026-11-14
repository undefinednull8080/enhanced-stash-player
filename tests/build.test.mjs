import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

import * as build from "../scripts/build.mjs";
import { checkManifest, checkPluginDir, parseYaml } from "../scripts/check-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(ROOT, "enhanced-stash-player");
const HAS_UNZIP = spawnSync("unzip", ["-v"]).status === 0;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "esp-build-"));
}

// Reads a zip through its central directory, the way archive/zip does.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "no end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const mode = buf.readUInt32LE(at + 38) >>> 16;
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(build.crc32(data), crc, `crc of ${name}`);
    files.push({ name, data, mode, method });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

describe("crc32 and sha256", () => {
  test("known vectors", () => {
    assert.equal(build.crc32(Buffer.from("123456789")), 0xcbf43926);
    assert.equal(build.crc32(Buffer.alloc(0)), 0);
    assert.equal(
      build.sha256Hex(Buffer.from("abc")),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("dates", () => {
  test("formatUtcDate uses UTC and Stash's format", () => {
    assert.equal(build.formatUtcDate(0), "1970-01-01 00:00:00");
    assert.equal(build.formatUtcDate(1763131547), "2025-11-14 14:45:47");
  });
  test("dosDateTime packs UTC fields", () => {
    const { time, date } = build.dosDateTime(new Date(Date.UTC(2025, 10, 14, 14, 45, 47)));
    assert.equal(time, (14 << 11) | (45 << 5) | 23);
    assert.equal(date, (45 << 9) | (11 << 5) | 14);
  });
});

describe("versions", () => {
  test("stable is the tag without v", () => {
    assert.equal(build.stableVersion("v0.1.0"), "0.1.0");
    assert.equal(build.stableVersion("v1.2.3-rc.1"), "1.2.3-rc.1");
    assert.throws(() => build.stableVersion("0.1.0"));
    assert.throws(() => build.stableVersion("vnext"));
  });
  test("dev is the manifest version plus the short sha", () => {
    assert.equal(build.devVersion("0.1.0", "abc1234"), "0.1.0-dev.abc1234");
  });
  test("rewriteVersion replaces only the top-level version line", () => {
    const yml = "name: X\nversion: 0.1.0\nsettings:\n  a:\n    version: keep\n";
    const out = build.rewriteVersion(yml, "0.2.0-dev.abc1234");
    assert.equal(out, 'name: X\nversion: "0.2.0-dev.abc1234"\nsettings:\n  a:\n    version: keep\n');
    assert.throws(() => build.rewriteVersion("name: X\n", "1.0.0"));
  });
  test("readTopLevel handles plain, double- and single-quoted values", () => {
    const yml = 'name: Plain Name\ndescription: "A: b \\"c\\""\nversion: \'0.1.0\'\n';
    assert.equal(build.readTopLevel(yml, "name"), "Plain Name");
    assert.equal(build.readTopLevel(yml, "description"), 'A: b "c"');
    assert.equal(build.readTopLevel(yml, "version"), "0.1.0");
    assert.equal(build.readTopLevel(yml, "url"), undefined);
  });
});

describe("renderIndex", () => {
  const index = build.renderIndex({
    id: "enhanced-stash-player",
    name: "Enhanced Stash Player",
    description: 'Colons: fine, "quotes" too',
    version: "0.1.0",
    date: "2025-11-14 14:45:47",
    path: "enhanced-stash-player.zip",
    sha256: "a".repeat(64),
  });

  test("matches the RemotePackage shape", () => {
    assert.equal(
      index,
      [
        "- id: enhanced-stash-player",
        '  name: "Enhanced Stash Player"',
        "  metadata:",
        '    description: "Colons: fine, \\"quotes\\" too"',
        '  version: "0.1.0"',
        '  date: "2025-11-14 14:45:47"',
        "  path: enhanced-stash-player.zip",
        "  sha256: " + "a".repeat(64),
        "  requires: []",
        "",
      ].join("\n"),
    );
  });

  test("parses back with the manifest YAML reader", () => {
    // parseYaml has no list-of-maps support, so read the entry body as a map.
    const body = index.replace(/^- /, "  ").replace(/^ {2}/gm, "");
    const entry = parseYaml(body.replace("requires: []", "requires: null"));
    assert.equal(entry.id, "enhanced-stash-player");
    assert.equal(entry.metadata.description, 'Colons: fine, "quotes" too');
    assert.equal(entry.date, "2025-11-14 14:45:47");
  });
});

describe("makeZip", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello hello hello hello hello hello") },
    { name: "dir/b.bin", data: Buffer.from([1]) },
    { name: "empty.txt", data: Buffer.alloc(0) },
  ];
  const mtime = new Date(Date.UTC(2025, 10, 14, 14, 45, 46));

  test("round-trips through a central-directory reader", () => {
    const files = readZip(build.makeZip(entries, mtime));
    assert.deepEqual(
      files.map((f) => f.name),
      ["a.txt", "dir/b.bin", "empty.txt"],
    );
    files.forEach((f, i) => assert.deepEqual(f.data, entries[i].data));
    assert.equal(files[0].method, 8, "compressible data is deflated");
    assert.equal(files[1].method, 0, "tiny data is stored");
    for (const f of files) assert.equal(f.mode, 0o100644);
  });

  test("is deterministic", () => {
    assert.deepEqual(build.makeZip(entries, mtime), build.makeZip(entries, mtime));
  });

  test("system unzip accepts it", { skip: !HAS_UNZIP && "unzip not installed" }, () => {
    const dir = tempDir();
    try {
      const file = join(dir, "t.zip");
      writeFileSync(file, build.makeZip(entries, mtime));
      const result = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /No errors detected/);
      assert.equal(execFileSync("unzip", ["-p", file, "a.txt"], { encoding: "utf8" }), entries[0].data.toString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildPackage", () => {
  const seconds = 1763131547;
  const pkg = build.buildPackage({ pluginDir: PLUGIN_DIR, version: "9.8.7", seconds });
  const files = readZip(pkg.zip);

  test("zips the plugin folder with files at the root", () => {
    const names = files.map((f) => f.name);
    assert.ok(names.includes("enhanced-stash-player.yml"));
    assert.ok(names.includes("esp-core.js"));
    assert.ok(names.every((n) => !n.includes("enhanced-stash-player/") && !n.startsWith(".")));
    assert.deepEqual(names, [...names].sort());
  });

  test("rewrites the zipped manifest version and leaves the rest alone", () => {
    const original = readFileSync(join(PLUGIN_DIR, "enhanced-stash-player.yml"), "utf8");
    const zipped = files.find((f) => f.name === "enhanced-stash-player.yml").data.toString("utf8");
    assert.equal(parseYaml(zipped).version, "9.8.7");
    assert.equal(zipped, build.rewriteVersion(original, "9.8.7"));
    const core = files.find((f) => f.name === "esp-core.js").data;
    assert.deepEqual(core, readFileSync(join(PLUGIN_DIR, "esp-core.js")));
  });

  test("index carries the version, commit date and the zip's sha256", () => {
    assert.equal(pkg.sha256, build.sha256Hex(pkg.zip));
    assert.match(pkg.index, /^- id: enhanced-stash-player\n/);
    assert.ok(pkg.index.includes('  version: "9.8.7"\n'));
    assert.ok(pkg.index.includes('  date: "2025-11-14 14:45:47"\n'));
    assert.ok(pkg.index.includes(`  sha256: ${pkg.sha256}\n`));
    assert.ok(pkg.index.includes("  path: enhanced-stash-player.zip\n"));
  });

  test("the zipped manifest still passes the manifest check", () => {
    const dir = tempDir();
    try {
      for (const f of files) {
        mkdirSync(dirname(join(dir, f.name)), { recursive: true });
        writeFileSync(join(dir, f.name), f.data);
      }
      assert.deepEqual(checkPluginDir(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("build CLI", () => {
  test("writes <out>/<channel>/ zip and index.yml", () => {
    const out = tempDir();
    try {
      const script = join(ROOT, "scripts", "build.mjs");
      const args = [script, "--channel", "stable", "--version", "1.0.0", "--date", "2025-11-14 14:45:47", "--out", out];
      const result = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const zip = readFileSync(join(out, "stable", "enhanced-stash-player.zip"));
      const index = readFileSync(join(out, "stable", "index.yml"), "utf8");
      assert.ok(index.includes(`sha256: ${build.sha256Hex(zip)}\n`));
      assert.ok(index.includes('date: "2025-11-14 14:45:47"'));
      if (HAS_UNZIP) {
        const file = join(out, "stable", "enhanced-stash-player.zip");
        assert.equal(spawnSync("unzip", ["-tq", file]).status, 0);
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("rejects bad arguments", () => {
    assert.throws(() => build.parseArgs([]), /--channel/);
    assert.throws(() => build.parseArgs(["--channel", "beta"]), /--channel/);
    assert.throws(() => build.parseArgs(["--channel", "dev", "--bogus", "x"]), /unknown/);
    assert.throws(() => build.parseArgs(["--channel"]), /missing value/);
    assert.deepEqual(build.parseArgs(["--channel", "dev", "--out", "x"]), { channel: "dev", out: "x" });
  });

  test("bad --date fails", () => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "scripts", "build.mjs"), "--channel", "dev", "--date", "2025-11-14", "--out", tmpdir()],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--date/);
  });
});

describe("check-manifest", () => {
  const exists = () => true;
  const good = () => ({
    name: "X",
    version: "0.1.0",
    ui: { javascript: ["a.js"], css: ["a.css"] },
    settings: { s: { displayName: "S", description: "d", type: "BOOLEAN" } },
  });

  test("the real plugin folder passes", () => {
    assert.deepEqual(checkPluginDir(PLUGIN_DIR), []);
  });

  test("a valid manifest has no errors", () => {
    assert.deepEqual(checkManifest(good(), exists), []);
  });

  test("unknown keys are rejected at every level", () => {
    const top = { ...good(), exec: ["node"] };
    assert.match(checkManifest(top, exists).join(), /"exec" is not allowed/);
    const ui = good();
    ui.ui.scripts = ["x"];
    assert.match(checkManifest(ui, exists).join(), /ui: key "scripts"/);
    const setting = good();
    setting.settings.s.default = true;
    assert.match(checkManifest(setting, exists).join(), /settings.s: key "default"/);
  });

  test("setting types and ui files are checked", () => {
    const m = good();
    m.settings.s.type = "INT";
    assert.match(checkManifest(m, exists).join(), /type must be one of/);
    assert.match(checkManifest(good(), (f) => f !== "a.css").join(), /ui.css: a.css does not exist/);
  });

  test("the folder must hold exactly one .yml, named after the plugin", () => {
    const dir = tempDir();
    try {
      const yml = "name: X\nui:\n  javascript:\n    - a.js\n";
      writeFileSync(join(dir, "a.js"), "");
      writeFileSync(join(dir, "other.yml"), yml);
      assert.match(checkPluginDir(dir).join(), /must be named enhanced-stash-player.yml/);
      writeFileSync(join(dir, "enhanced-stash-player.yml"), yml);
      assert.match(checkPluginDir(dir).join(), /exactly one .yml/);
      rmSync(join(dir, "other.yml"));
      assert.deepEqual(checkPluginDir(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parseYaml reads the block subset and rejects the rest", () => {
    const doc = parseYaml("# c\na: 1\nb:\n  - x\n  - 'y''s'\nc:\n  d: \"e # f\" # g\n  h: Don't # i\nlist:\n- z\n");
    assert.deepEqual(doc, { a: "1", b: ["x", "y's"], c: { d: "e # f", h: "Don't" }, list: ["z"] });
    assert.throws(() => parseYaml("a: [1, 2]\n"), /unsupported/);
    assert.throws(() => parseYaml("a: 1\na: 2\n"), /duplicate/);
    assert.throws(() => parseYaml("a: 1\n   b: 2\n"), /indentation|expected/);
  });
});
