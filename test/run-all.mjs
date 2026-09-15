/*
 * Runs every Parquetly verification suite and exits non-zero if any fail.
 *
 *   npm test            build the production bundle, then run everything
 *   node test/run-all.mjs   run against whatever is already in dist/
 *
 * The pyarrow cross-check runs only when Python with pyarrow is available,
 * and is reported as SKIPPED (not passed) otherwise.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const fixtures = ['inputs/titanic.parquet', 'inputs/sample-large.parquet'];
const missing = fixtures.filter(f => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error(`Missing test fixtures: ${missing.join(', ')}. The suites assert on their exact contents.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'dist/extension.js'))) {
  console.error('dist/extension.js not found. Run `npm run package` first (or use `npm test`).');
  process.exit(1);
}

const outDir = path.join(os.tmpdir(), `parquetly-verify-${process.pid}`);
const suites = [
  { name: 'webview', file: 'test/webview.test.mjs' },
  { name: 'edit-mode', file: 'test/edit-mode.test.mjs' },
  { name: 'host', file: 'test/host.test.cjs' },
  {
    name: 'roundtrip',
    file: 'test/roundtrip.test.cjs',
    env: { PARQUETLY_TEST_OUT: outDir, PARQUETLY_KEEP_OUTPUT: '1' },
  },
];

const results = [];
for (const suite of suites) {
  process.stdout.write(`\n=== ${suite.name} ===\n`);
  const run = spawnSync(process.execPath, [path.join(ROOT, suite.file)], {
    cwd: ROOT,
    env: { ...process.env, ...(suite.env || {}) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const failures = output.split('\n').filter(line => line.startsWith('FAIL'));
  const found = output.split('\n').reverse().find(line => /\d+\/\d+ .*passed/.test(line));
  const summary = found || (run.status === 0 ? '(no summary)' : '(crashed before printing a summary)');
  failures.forEach(line => console.log(line));
  console.log(summary);
  // A suite that throws never prints its tally, so show the tail to make the crash visible.
  if (run.status !== 0 && !found) {
    console.log(output.split('\n').slice(-25).join('\n'));
  }
  results.push({ name: suite.name, ok: run.status === 0, summary });
}

// Cross-implementation check: a file we can only read back with our own
// library could still violate the Parquet spec.
const python = ['python', 'python3'].find(cmd =>
  spawnSync(cmd, ['-c', 'import pyarrow'], { encoding: 'utf8' }).status === 0);
process.stdout.write('\n=== pyarrow cross-check ===\n');
if (!python) {
  console.log('SKIPPED - Python with pyarrow not found (pip install pyarrow to enable)');
  results.push({ name: 'pyarrow', ok: true, skipped: true, summary: 'skipped' });
} else if (!fs.existsSync(outDir)) {
  console.log('FAIL - roundtrip suite produced no output to cross-check');
  results.push({ name: 'pyarrow', ok: false, summary: 'no output' });
} else {
  const run = spawnSync(python, [path.join(ROOT, 'test/crosscheck_pyarrow.py'), outDir, ROOT], { encoding: 'utf8' });
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  console.log(output);
  results.push({ name: 'pyarrow', ok: run.status === 0, summary: output.split('\n').pop() });
}
fs.rmSync(outDir, { recursive: true, force: true });

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${r.summary}`);
}
const failed = results.filter(r => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} suite(s) failed: ${failed.map(f => f.name).join(', ')}`);
  process.exit(1);
}
console.log('\nAll suites passed.');
