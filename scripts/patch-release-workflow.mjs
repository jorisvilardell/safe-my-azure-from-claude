#!/usr/bin/env node
// Patches .github/workflows/release.yml after `dist generate`: in every job that runs dist on the
// checked-out workspace, the version files are set from the tag before dist reads them, so the
// tag is the only source of the release version (v1.2.3-rc.1 and then v1.2.3 can be cut from the
// same commit). Idempotent. dist-workspace.toml has allow-dirty = ["ci"] for this file, and the
// release dry run checks that `dist generate` + this script reproduce the committed file.
//
//   dist generate && node scripts/patch-release-workflow.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.github/workflows/release.yml');
const JOBS = new Set(['plan', 'build-local-artifacts', 'build-global-artifacts', 'host']);
const MARKER = '# Patched by scripts/patch-release-workflow.mjs';
const STEPS = [
  `      ${MARKER}: the tag is the version (vX.Y.Z -> X.Y.Z).`,
  '      - uses: actions/setup-node@v7',
  '        with:',
  '          node-version: 24',
  '      - name: Version from the tag',
  "        if: ${{ github.ref_type == 'tag' }}",
  '        shell: bash',
  '        run: node scripts/bump-version.mjs "${GITHUB_REF_NAME#v}"',
];

const eol = readFileSync(FILE, 'utf8').includes('\r\n') ? '\r\n' : '\n';
const lines = readFileSync(FILE, 'utf8').split(/\r?\n/);
const out = [];
const patched = new Set();
let job = '';
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
  if (header) job = header[1];
  out.push(line);
  // The end of the job's actions/checkout step.
  if (JOBS.has(job) && !patched.has(job) && line === '          submodules: recursive') {
    patched.add(job);
    if (!(lines[i + 1] ?? '').includes(MARKER)) out.push(...STEPS);
  }
}

const missing = [...JOBS].filter((j) => !patched.has(j));
if (missing.length > 0) {
  process.stderr.write(`error: no actions/checkout step found in job(s): ${missing.join(', ')}\n`);
  process.exit(1);
}
writeFileSync(FILE, out.join(eol));
process.stdout.write(`Patched ${[...patched].join(', ')} in .github/workflows/release.yml.\n`);
