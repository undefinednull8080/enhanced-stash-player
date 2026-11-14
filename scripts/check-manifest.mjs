#!/usr/bin/env node
// Checks the plugin folder the way Stash v0.31.0 would load it (pkg/plugin/config.go parses the
// manifest strictly, so an unknown key stops the plugin from loading).
//
//   node scripts/check-manifest.mjs [pluginDir]
//
// Checks: exactly one .yml in the folder, named after the plugin id; only the keys this plugin may
// use; setting types are STRING, NUMBER or BOOLEAN; every ui.javascript / ui.css file exists.
// No YAML library: parseYaml reads the block-style subset the manifest uses and rejects the rest.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PLUGIN_ID = "enhanced-stash-player";

// Narrower than Stash allows: this plugin must never use exec, tasks, hooks or interface.
const TOP_KEYS = ["name", "description", "version", "url", "ui", "settings"];
const UI_KEYS = ["javascript", "css", "requires", "assets", "csp"];
const CSP_KEYS = ["script-src", "style-src", "connect-src"];
const SETTING_KEYS = ["displayName", "description", "type"];
const SETTING_TYPES = ["STRING", "NUMBER", "BOOLEAN"];

function parseScalar(text, lineNo) {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`line ${lineNo}: bad double-quoted string`);
    }
  }
  if (text.startsWith("'")) {
    if (!/^'([^']|'')*'$/.test(text)) throw new Error(`line ${lineNo}: bad single-quoted string`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[[{|>&*!]/.test(text)) throw new Error(`line ${lineNo}: unsupported YAML syntax: ${text}`);
  return text;
}

// A "#" starts a comment at the line start or after whitespace, outside quotes.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if ((c === '"' || c === "'") && /(^\s*|:\s+|-\s+)$/.test(line.slice(0, i))) {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Block maps and block lists of scalars, by indentation. Returns plain objects and arrays.
export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = stripComment(raw).replace(/\s+$/, "");
    if (!line.trim() || line === "---") return;
    if (/^\s*\t/.test(line)) throw new Error(`line ${i + 1}: tabs are not allowed for indentation`);
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim(), no: i + 1 });
  });

  let pos = 0;

  function parseBlock(indent) {
    const first = lines[pos];
    if (first.text.startsWith("- ") || first.text === "-") return parseList(indent);
    return parseMap(indent);
  }

  function parseList(indent) {
    const list = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("-")) {
      const { text, no } = lines[pos++];
      const value = text.slice(1).trim();
      if (!value) throw new Error(`line ${no}: nested list items are not supported`);
      if (/^[^"'][^:]*:(\s|$)/.test(value)) throw new Error(`line ${no}: maps inside lists are not supported`);
      list.push(parseScalar(value, no));
    }
    return list;
  }

  function parseMap(indent) {
    const map = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const { text, no } = lines[pos++];
      const match = /^([^\s"'#][^:]*?|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(text);
      if (!match) throw new Error(`line ${no}: expected "key: value"`);
      const key = parseScalar(match[1], no);
      if (Object.hasOwn(map, key)) throw new Error(`line ${no}: duplicate key ${key}`);
      if (match[2] !== undefined && match[2] !== "") {
        map[key] = parseScalar(match[2], no);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        map[key] = parseBlock(lines[pos].indent);
      } else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith("-")) {
        map[key] = parseList(indent);
      } else {
        map[key] = null;
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new Error(`line ${lines[pos].no}: unexpected indentation`);
    }
    return map;
  }

  if (!lines.length) return null;
  const doc = parseBlock(0);
  if (pos < lines.length) throw new Error(`line ${lines[pos].no}: unexpected content`);
  return doc;
}

function isMap(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkKeys(errors, where, value, allowed) {
  if (!isMap(value)) {
    errors.push(`${where} must be a map`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${where}: key "${key}" is not allowed`);
  }
  return true;
}

function checkStringList(errors, where, value) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    errors.push(`${where} must be a list of strings`);
    return [];
  }
  return value;
}

// Returns a list of problems with a parsed manifest. fileExists(name) checks ui files.
export function checkManifest(manifest, fileExists) {
  const errors = [];
  if (!checkKeys(errors, "manifest", manifest, TOP_KEYS)) return errors;
  if (typeof manifest.name !== "string" || !manifest.name) errors.push("name is required");
  for (const key of ["description", "version", "url"]) {
    if (key in manifest && typeof manifest[key] !== "string") errors.push(`${key} must be a string`);
  }

  if ("ui" in manifest && checkKeys(errors, "ui", manifest.ui, UI_KEYS)) {
    const ui = manifest.ui;
    for (const key of ["javascript", "css"]) {
      if (!(key in ui)) continue;
      for (const file of checkStringList(errors, `ui.${key}`, ui[key])) {
        if (!fileExists(file)) errors.push(`ui.${key}: ${file} does not exist`);
      }
    }
    if ("requires" in ui) checkStringList(errors, "ui.requires", ui.requires);
    if ("csp" in ui && checkKeys(errors, "ui.csp", ui.csp, CSP_KEYS)) {
      for (const key of Object.keys(ui.csp)) checkStringList(errors, `ui.csp.${key}`, ui.csp[key]);
    }
    if ("assets" in ui && !isMap(ui.assets)) errors.push("ui.assets must be a map");
  }

  if ("settings" in manifest && !isMap(manifest.settings)) {
    errors.push("settings must be a map");
  } else if ("settings" in manifest) {
    for (const [name, setting] of Object.entries(manifest.settings)) {
      if (!checkKeys(errors, `settings.${name}`, setting, SETTING_KEYS)) continue;
      if (!SETTING_TYPES.includes(setting.type)) {
        errors.push(`settings.${name}.type must be one of ${SETTING_TYPES.join(", ")}`);
      }
    }
  }
  return errors;
}

// Checks a plugin folder on disk. Returns a list of problems (empty when fine).
export function checkPluginDir(dir) {
  const ymls = readdirSync(dir).filter((name) => /\.ya?ml$/i.test(name));
  const expected = PLUGIN_ID + ".yml";
  if (ymls.length !== 1) return [`expected exactly one .yml in ${dir}, found ${ymls.length}: ${ymls.join(", ")}`];
  if (ymls[0] !== expected) return [`the manifest must be named ${expected}, found ${ymls[0]}`];

  let manifest;
  try {
    manifest = parseYaml(readFileSync(join(dir, expected), "utf8"));
  } catch (err) {
    return [`${expected}: ${err.message}`];
  }
  return checkManifest(manifest, (file) => existsSync(join(dir, file)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = resolve(process.argv[2] || join(root, PLUGIN_ID));
  const errors = checkPluginDir(dir);
  if (errors.length) {
    for (const err of errors) console.error("check-manifest: " + err);
    process.exit(1);
  }
  console.log(`check-manifest: ${dir} is fine`);
}
