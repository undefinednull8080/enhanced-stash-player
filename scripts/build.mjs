#!/usr/bin/env node
// Packages the plugin folder for a Stash plugin source.
//
//   node scripts/build.mjs --channel dev|stable [--repo DIR] [--out DIR]
//                          [--version V] [--date "YYYY-MM-DD HH:MM:SS"]
//
// Writes <out>/<channel>/enhanced-stash-player.zip and <out>/<channel>/index.yml.
// --repo is the git checkout to package (default: this repo). The version and date come from
// that checkout unless given: stable needs HEAD to be a v* tag, dev uses the manifest version
// plus the short commit sha. No dependencies.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateRawSync } from "node:zlib";

export const PLUGIN_ID = "enhanced-stash-player";
export const ZIP_NAME = PLUGIN_ID + ".zip";
export const MANIFEST_NAME = PLUGIN_ID + ".yml";
export const CHANNELS = ["stable", "dev"];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---- zip writer ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// MS-DOS date and time fields, from the UTC parts of `date`.
export function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: day };
}

// entries: [{name, data: Buffer}] in the order they should appear. Every entry gets the same
// timestamp so the output depends only on the inputs.
export function makeZip(entries, mtime) {
  const { time, date } = dosDateTime(mtime);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    // Bit 11: names are UTF-8.
    const flags = /^[\x20-\x7e]*$/.test(name) ? 0 : 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by Unix, so readers (Go's archive/zip included) take the mode from the external attributes.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

// ---- manifest and index ----

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Unix seconds → "YYYY-MM-DD HH:MM:SS" in UTC (Stash's pkg.TimeFormat).
export function formatUtcDate(seconds) {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) return JSON.parse(text);
  if (text.startsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text.replace(/\s+#.*$/, "");
}

// Reads a top-level scalar such as `name:` from the manifest text.
export function readTopLevel(ymlText, key) {
  const match = ymlText.match(new RegExp("^" + key + ":[ \\t]*(.*)$", "m"));
  return match ? parseScalar(match[1]) : undefined;
}

export function rewriteVersion(ymlText, version) {
  const pattern = /^version:.*$/m;
  if (!pattern.test(ymlText)) throw new Error("manifest has no top-level version: line");
  return ymlText.replace(pattern, "version: " + JSON.stringify(version));
}

export function stableVersion(tag) {
  if (!/^v\d/.test(tag)) throw new Error(`not a v* release tag: ${tag}`);
  return tag.slice(1);
}

export function devVersion(baseVersion, shortSha) {
  return `${baseVersion}-dev.${shortSha}`;
}

// One RemotePackage entry (stash pkg/pkg/pkg.go). Strings are JSON-quoted, which is valid YAML.
export function renderIndex({ id, name, description, version, date, path, sha256 }) {
  const q = JSON.stringify;
  return [
    `- id: ${id}`,
    `  name: ${q(name)}`,
    `  metadata:`,
    `    description: ${q(description)}`,
    `  version: ${q(version)}`,
    `  date: ${q(date)}`,
    `  path: ${path}`,
    `  sha256: ${sha256}`,
    `  requires: []`,
    "",
  ].join("\n");
}

// ---- packaging ----

// Regular files under dir, sorted, with forward-slash names. Dotfiles are skipped.
export function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listFiles(full, prefix + name + "/"));
    else if (stat.isFile()) out.push(prefix + name);
  }
  return out;
}

// Builds the zip and index text in memory. `seconds` is the commit time.
export function buildPackage({ pluginDir, version, seconds }) {
  const files = listFiles(pluginDir);
  if (!files.includes(MANIFEST_NAME)) throw new Error(`${MANIFEST_NAME} not found in ${pluginDir}`);

  const manifestText = readFileSync(join(pluginDir, MANIFEST_NAME), "utf8");
  const entries = files.map((name) => {
    if (name !== MANIFEST_NAME) return { name, data: readFileSync(join(pluginDir, name)) };
    return { name, data: Buffer.from(rewriteVersion(manifestText, version), "utf8") };
  });

  const zip = makeZip(entries, new Date(seconds * 1000));
  const sha256 = sha256Hex(zip);
  const index = renderIndex({
    id: PLUGIN_ID,
    name: readTopLevel(manifestText, "name"),
    description: readTopLevel(manifestText, "description") || "",
    version,
    date: formatUtcDate(seconds),
    path: ZIP_NAME,
    sha256,
  });
  return { zip, sha256, index, files };
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

// "YYYY-MM-DD HH:MM:SS" (UTC) → Unix seconds.
function parseDateArg(text) {
  const match = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(text);
  if (!match) throw new Error(`--date must look like "YYYY-MM-DD HH:MM:SS": ${text}`);
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const key = arg.replace(/^--/, "");
    if (!arg.startsWith("--") || !["channel", "repo", "out", "version", "date"].includes(key)) {
      throw new Error(`unknown argument: ${arg}`);
    }
    if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
    opts[key] = argv[++i];
  }
  if (!CHANNELS.includes(opts.channel)) throw new Error("--channel must be stable or dev");
  return opts;
}

export function build(opts) {
  const repo = resolve(opts.repo || ROOT);
  const out = resolve(opts.out || join(ROOT, "dist"));
  const pluginDir = join(repo, PLUGIN_ID);

  const seconds = opts.date ? parseDateArg(opts.date) : Number(git(repo, "log", "-1", "--format=%ct"));
  let version = opts.version;
  if (!version && opts.channel === "stable") {
    version = stableVersion(git(repo, "describe", "--tags", "--exact-match", "--match", "v*", "HEAD"));
  }
  if (!version) {
    const base = readTopLevel(readFileSync(join(pluginDir, MANIFEST_NAME), "utf8"), "version");
    version = devVersion(base, git(repo, "rev-parse", "--short=7", "HEAD"));
  }

  const pkg = buildPackage({ pluginDir, version, seconds });
  const dir = join(out, opts.channel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ZIP_NAME), pkg.zip);
  writeFileSync(join(dir, "index.yml"), pkg.index);
  return { ...pkg, dir, version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = build(parseArgs(process.argv.slice(2)));
    console.log(`${result.dir}: ${ZIP_NAME} ${result.version} (${result.files.length} files) sha256 ${result.sha256}`);
  } catch (err) {
    console.error("build: " + err.message);
    process.exit(1);
  }
}
