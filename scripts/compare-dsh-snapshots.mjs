import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const [beforePath, afterPath, reportPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !reportPath) {
  throw new Error(
    'usage: node scripts/compare-dsh-snapshots.mjs <before.json> <after.json> <report.txt>',
  );
}

const [beforeBytes, afterBytes] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
const before = JSON.parse(beforeBytes.toString('utf8').replace(/^\uFEFF/u, ''));
const after = JSON.parse(afterBytes.toString('utf8').replace(/^\uFEFF/u, ''));
const byPath = (entries) => new Map(entries.map((entry) => [entry.path, entry]));
const beforeMap = byPath(before);
const afterMap = byPath(after);
const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
const differences = paths.flatMap((path) => {
  const previous = beforeMap.get(path);
  const current = afterMap.get(path);
  return JSON.stringify(previous) === JSON.stringify(current)
    ? []
    : [{ path, before: previous ?? null, after: current ?? null }];
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const summary = [
  `before_files=${before.length}`,
  `after_files=${after.length}`,
  `diff_count=${differences.length}`,
  `before_snapshot_sha256=${sha256(beforeBytes)}`,
  `after_snapshot_sha256=${sha256(afterBytes)}`,
];
if (differences.length > 0) summary.push(JSON.stringify(differences, null, 2));

await writeFile(reportPath, `${summary.join('\n')}\n`, 'utf8');
console.log(summary.join('\n'));
if (differences.length > 0) process.exitCode = 1;
