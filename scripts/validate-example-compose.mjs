// Runs the shipped compose example instead of asserting things about its text.
//
// The example exists to show the one thing compose does that a plain copy would not: it refuses to
// guess when two sources ship the same id. So this checks both halves. Asserting only that the
// example composes would let it rot into a manifest with no collision left in it — still green,
// while the thing it is supposed to demonstrate quietly stopped being demonstrated.
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse, stringify } from 'yaml';

const run = promisify(execFile);
const cli = resolve('packages/cli/dist/bin.js');
const exampleRoot = resolve('examples/compose');

/** execFile rejects on non-zero exit, and a non-zero exit is an expected outcome here. */
async function compose(manifest, output) {
  try {
    await run(process.execPath, [cli, 'compose', manifest, '--output', output, '--json']);
    return 0;
  } catch (error) {
    if (typeof error.code !== 'number') throw error;
    return error.code;
  }
}

const scratch = await mkdtemp(join(tmpdir(), 'dshpack-example-compose-'));
try {
  const composed = join(scratch, 'notes-kit');
  const code = await compose(join(exampleRoot, 'compose.yml'), composed);
  if (code !== 0) throw new Error(`示例 compose 应成功，实际退出码 ${code}`);

  // `prefer` picking the team source has to be checked by content: both sources deploy to the same
  // path, so the file existing says nothing about which one won.
  const skill = await readFile(join(composed, 'skills/note-taking/SKILL.md'), 'utf8');
  if (!skill.includes('note-taking (team)'))
    throw new Error('resolve.prefer 未生效：产出的 skill 不是 team-notes 变体');

  // `from:` is relative and the schema only accepts it that way, so the stripped manifest has to
  // sit where the original does. Copy the tree rather than write into the working directory.
  const mirror = join(scratch, 'example');
  await cp(exampleRoot, mirror, { recursive: true });
  const manifestPath = join(mirror, 'compose.yml');
  const manifest = parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.resolve) || manifest.resolve.length === 0)
    throw new Error('示例已不含 resolve 块，冲突演示失效');
  delete manifest.resolve;
  await writeFile(manifestPath, stringify(manifest));
  const conflict = await compose(manifestPath, join(scratch, 'unresolved'));
  if (conflict !== 30)
    throw new Error(`去掉 resolve 后应以 30 拒绝，实际退出码 ${conflict}——示例不再演示真实冲突`);

  console.log('compose:validate: examples/compose 组装成功，且去掉 resolve 后以 30 拒绝');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
