// Guards the READMEs against the drift that shipped in 0.2.1: `packages/cli/README.md` — the page
// npmjs.com shows — still said `init` / `pack` were unimplemented and listed 7 of the 17 commands,
// months after they shipped. The repo README had been brought up to date; the published one had
// not, and nothing connected the two. Behavioural checks cannot catch this: the tool was correct
// and the description of it was wrong.
//
// Three invariants, all mechanical:
//   1. every command the CLI registers is named somewhere in each README;
//   2. no README calls a registered command unimplemented;
//   3. the prerelease notice names the version series actually being published.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { COMMAND_NAMES } from '../packages/cli/dist/index.js';

const version = JSON.parse(await readFile(resolve('packages/cli/package.json'), 'utf8')).version;
const series = version.split('.').slice(0, 2).join('.');

/**
 * Matches the command inside an inline-code span, optionally prefixed with `dshpack `, and only
 * when what follows ends the name: a backtick, a space, or the start of an argument placeholder.
 * Without that last part `pack` would be satisfied by any mention of `pack.yml`.
 */
const mentions = (text, name) => new RegExp(`\`(?:dshpack )?${name}(?=\`| |<|\\[)`, 'u').test(text);

const failures = [];
for (const path of ['README.md', 'packages/cli/README.md']) {
  const text = await readFile(resolve(path), 'utf8');
  const missing = COMMAND_NAMES.filter((name) => !mentions(text, name));
  if (missing.length > 0) failures.push(`${path} 未提及命令：${missing.join(', ')}`);

  // The claim that bit twice was not a missing row but a sentence asserting a shipped command did
  // not exist. Scan the short span after each inline-code command name for that assertion; the
  // window is narrow enough that "`init` … 未实现" three clauses later does not trip it.
  for (const name of COMMAND_NAMES) {
    const claim = new RegExp(
      `\`(?:dshpack )?${name}\`[^\\n]{0,40}?(尚未实现|仍未实现|未实现)`,
      'u',
    );
    if (claim.test(text)) failures.push(`${path} 称已发布的 ${name} 未实现`);
  }
  if (!text.includes(`${series}.x`))
    failures.push(`${path} 的预发布说明未写当前版本序列 ${series}.x（当前 ${version}）`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`);
  throw new Error('README 与已发布命令集不一致');
}
console.log(
  `readme:verify: 两份 README 覆盖全部 ${COMMAND_NAMES.length} 个命令，版本序列 ${series}.x`,
);
