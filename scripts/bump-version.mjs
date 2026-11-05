#!/usr/bin/env node
// Version lock (ADR 0001 §7): the CLI version is the Docker image tag, so the npm package and the
// Rust crate must always carry the same version. This script is the only way to change it.
//
//   node scripts/bump-version.mjs 1.2.3        set the version everywhere
//   node scripts/bump-version.mjs --check      fail if the files disagree
//   node scripts/bump-version.mjs --check 1.2.3  fail unless every file is at 1.2.3 (release tag)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = 'safe-azure';
// Same format as the tag check in release-version-check.yml: X.Y.Z or X.Y.Z-(alpha|beta|rc).N.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/;

const file = (rel) => join(ROOT, rel);
const read = (rel) => readFileSync(file(rel), 'utf8');

// The version line of the [package] table, before any other table starts.
const CARGO_TOML_VERSION = /(^\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m;
// The version line right after `name = "safe-azure"` in a [[package]] entry of Cargo.lock.
const CARGO_LOCK_VERSION = new RegExp(`(^name = "${CRATE}"\\r?\\nversion = ")([^"]+)(")`, 'm');

function match(rel, regex) {
  const m = regex.exec(read(rel));
  if (!m?.[2]) fail(`${rel}: could not find the ${CRATE} version`);
  return m[2];
}

function readVersions() {
  const lock = JSON.parse(read('package-lock.json'));
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'package-lock.json': lock.version,
    'package-lock.json (packages[""])': lock.packages?.['']?.version,
    'cli/Cargo.toml': match('cli/Cargo.toml', CARGO_TOML_VERSION),
    'cli/Cargo.lock': match('cli/Cargo.lock', CARGO_LOCK_VERSION),
  };
}

function writeJson(rel, update) {
  const data = JSON.parse(read(rel));
  update(data);
  writeFileSync(file(rel), `${JSON.stringify(data, null, 2)}\n`);
}

function replace(rel, regex, version) {
  const text = read(rel);
  if (!regex.test(text)) fail(`${rel}: could not find the ${CRATE} version`);
  writeFileSync(file(rel), text.replace(regex, `$1${version}$3`));
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function check(expected) {
  const versions = readVersions();
  const want = expected ?? versions['package.json'];
  const wrong = Object.entries(versions).filter(([, v]) => v !== want);
  if (wrong.length > 0) {
    const table = Object.entries(versions)
      .map(([f, v]) => `  ${f}: ${String(v)}`)
      .join('\n');
    fail(`versions are not all ${want}:\n${table}\nRun: node scripts/bump-version.mjs <X.Y.Z>`);
  }
  process.stdout.write(`All versions are ${want}.\n`);
}

function bump(version) {
  writeJson('package.json', (pkg) => {
    pkg.version = version;
  });
  writeJson('package-lock.json', (lock) => {
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
  });
  replace('cli/Cargo.toml', CARGO_TOML_VERSION, version);
  replace('cli/Cargo.lock', CARGO_LOCK_VERSION, version);
  check(version);
}

const args = process.argv.slice(2);
const isCheck = args[0] === '--check';
const version = isCheck ? args[1] : args[0];
if (version !== undefined) {
  const bare = version.replace(/^v/, '');
  if (!SEMVER.test(bare)) fail(`"${version}" is not a version like 1.2.3 or 1.2.3-rc.1`);
  if (isCheck) check(bare);
  else bump(bare);
} else if (isCheck) {
  check(undefined);
} else {
  fail('usage: node scripts/bump-version.mjs <X.Y.Z> | --check [X.Y.Z]');
}
