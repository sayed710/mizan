// Coverage of the source only (TEST-005): runs the suite with V8 coverage, then reports lines, branches and
// functions per area without the test files, lists the source files no test ever loads, and fails below the minimums.
//   npm run coverage
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Ratchet: raise these as coverage improves; never lower them to get a change through.
const MINIMUM = { branches: 83, functions: 79 };

const dir = mkdtempSync(join(tmpdir(), 'mizan-coverage-'));
const lcov = join(dir, 'lcov.info');
const run = spawnSync(process.execPath, [
  '--test', '--experimental-test-coverage', '--test-coverage-exclude=**/*.test.js',
  '--test-reporter=dot', '--test-reporter-destination=stdout',
  '--test-reporter=lcov', `--test-reporter-destination=${lcov}`,
  'src/**/*.test.js', 'server/**/*.test.js',
], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
if (run.status !== 0) process.exit(run.status ?? 1);

/** Per-file totals from an lcov report. */
function parse(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split('\n')) {
    const [key, value] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)];
    if (key === 'SF') files.set(relative(ROOT, value), (current = { lines: [0, 0], branches: [0, 0], functions: [0, 0] }));
    else if (current && ['LH', 'LF', 'BRH', 'BRF', 'FNH', 'FNF'].includes(key)) {
      const [kind, slot] = { LH: ['lines', 0], LF: ['lines', 1], BRH: ['branches', 0], BRF: ['branches', 1], FNH: ['functions', 0], FNF: ['functions', 1] }[key];
      current[kind][slot] += Number(value);
    }
  }
  return files;
}

const covered = parse(readFileSync(lcov, 'utf8'));
rmSync(dir, { recursive: true, force: true });

const sources = (sub) => readdirSync(join(ROOT, sub), { recursive: true })
  .filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.js$/.test(f)).map((f) => join(sub, f));
const all = [...sources('src'), ...sources('server')];
const areaOf = (file) => {
  const norm = file.replace(/\\/g, '/');
  return norm.startsWith('server/') ? 'server' : norm.startsWith('src/models/') ? 'src/models' : 'src (other)';
};

const pct = ([hit, found]) => (found ? (100 * hit) / found : 100);
const fmt = (pair) => `${pct(pair).toFixed(1).padStart(5)}% (${pair[0]}/${pair[1]})`;
const sum = (list) => list.reduce((acc, f) => ({
  lines: [acc.lines[0] + f.lines[0], acc.lines[1] + f.lines[1]],
  branches: [acc.branches[0] + f.branches[0], acc.branches[1] + f.branches[1]],
  functions: [acc.functions[0] + f.functions[0], acc.functions[1] + f.functions[1]],
}), { lines: [0, 0], branches: [0, 0], functions: [0, 0] });

console.log('\nSource coverage (test files excluded)');
for (const area of ['src/models', 'src (other)', 'server']) {
  const totals = sum([...covered].filter(([f]) => areaOf(f) === area).map(([, t]) => t));
  console.log(`  ${area.padEnd(12)} lines ${fmt(totals.lines)}  branches ${fmt(totals.branches)}  functions ${fmt(totals.functions)}`);
}
const overall = sum([...covered.values()]);

const lineCount = (file) => readFileSync(join(ROOT, file), 'utf8').split('\n').length;
const unloaded = all.filter((f) => !covered.has(f));
const unloadedLines = unloaded.reduce((s, f) => s + lineCount(f), 0);
const allLines = all.reduce((s, f) => s + lineCount(f), 0);
console.log(`\nNever loaded by any test: ${unloaded.length} files, ${unloadedLines} of ${allLines} source lines (${((100 * unloadedLines) / allLines).toFixed(1)}%)`);
for (const file of unloaded) console.log(`  ${file}${file.endsWith('.jsx') ? '  (React view: needs a browser test)' : ''}`);

const failures = Object.entries(MINIMUM).filter(([kind, min]) => pct(overall[kind]) < min)
  .map(([kind, min]) => `${kind} ${pct(overall[kind]).toFixed(1)}% is below the minimum ${min}%`);
console.log(`\nOverall loaded source: lines ${fmt(overall.lines)}  branches ${fmt(overall.branches)}  functions ${fmt(overall.functions)}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
