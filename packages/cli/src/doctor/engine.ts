import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Diagnostic,
  inspectSkill,
  parseCanonicalYaml,
  preparePatchExport,
  scanSecrets,
} from '@dshpack/core';

import { runDsh } from '../adapters/process.js';
import { type CommandReport, diagnostic, strictDiagnostics } from '../commands/shared.js';
import { EXIT_CODES, type ExitCode } from '../exit-codes.js';
import { checkBundles, checkPnpm, checkSettings, dshVersion } from './checks.js';
import {
  type DoctorInput,
  type DoctorMetadata,
  dshOptions,
  markdownFiles,
  type ProfileFacts,
  profileDiagnostic,
  readProfile,
  sideEffects,
  text,
  versionAtLeast,
} from './support.js';

export type { DoctorInput, DoctorMetadata } from './support.js';

function doctorExit(diagnostics: readonly Diagnostic[]): ExitCode {
  if (!diagnostics.some(({ severity }) => severity === 'error')) return EXIT_CODES.SUCCESS;
  if (diagnostics.some(({ code }) => ['DSH001', 'DSH002', 'DSH003'].includes(code)))
    return EXIT_CODES.ENVIRONMENT;
  if (diagnostics.some(({ code }) => code === 'DSH014' || code === 'DSH018'))
    return EXIT_CODES.SECURITY;
  return EXIT_CODES.CONTRACT;
}

async function fixEmptyPatch(
  facts: ProfileFacts,
  input: DoctorInput,
  diagnostics: Diagnostic[],
): Promise<void> {
  if (facts.patch.trim().length !== 0 || input.fix !== true) return;
  if (input.yes !== true) {
    diagnostics.push(
      diagnostic(
        'DSH008',
        'warning',
        '空 patch 可自动写为 []，但默认拒绝写盘。',
        `非交互执行：dshpack doctor --profile ${input.profile as string} --fix --yes`,
      ),
    );
    return;
  }
  await writeFile(join(facts.root, 'cordis.patch.yml'), '[]\n', 'utf8');
  diagnostics.push(
    diagnostic(
      'DSH008',
      'info',
      '已将空 cordis.patch.yml 修复为合法的 []。',
      '重新运行 doctor 确认。',
      join(facts.root, 'cordis.patch.yml'),
    ),
  );
}

async function fixSkillName(
  path: string,
  source: string,
  input: DoctorInput,
  diagnostics: Diagnostic[],
): Promise<void> {
  if (input.fix !== true || input.yes !== true || !source.startsWith('---')) return;
  const body = source.slice(3);
  const end = body.indexOf('\n---');
  if (end < 0 || /^\s*name\s*:/mu.test(body.slice(0, end))) return;
  const name = path.replaceAll('\\', '/').split('/').at(-2) ?? 'skill';
  await writeFile(path, `---\nname: ${name}\n${body}`, 'utf8');
  diagnostics.push(
    diagnostic('DSH010', 'info', '已从目录名补全 skill name。', '重新运行 doctor 确认。', path),
  );
}

/** Registered DSH001–018 checks. Dump checks may cause dsh to write profile/cordis.yml. */
export async function runDoctor(input: DoctorInput): Promise<CommandReport<DoctorMetadata>> {
  const diagnostics: Diagnostic[] = [];
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  if (!versionAtLeast(nodeVersion, [22, 19, 0]) || nodeVersion.startsWith('25.'))
    diagnostics.push(
      profileDiagnostic('DSH001', 'Node 版本必须是 >=22.19 且 <25。', '切换到受支持 Node 版本。'),
    );
  await checkPnpm(input, diagnostics);
  const version = await dshVersion(input, diagnostics);
  if (input.profile !== undefined) {
    const profile = await readProfile(input.dshHome, input.profile);
    diagnostics.push(...profile.diagnostics);
    if (profile.facts !== undefined) {
      const marker = await text(
        join(input.dshHome, '.dshpack', 'installed', `${input.profile}.json`),
      );
      if (marker === undefined && input.yes !== true) {
        diagnostics.push(
          diagnostic(
            'DSH009',
            'warning',
            '该 untracked profile 的 dump 会由 dsh 生成或重写 cordis.yml，默认未确认。',
            `非交互执行：dshpack doctor --profile ${input.profile} --yes`,
          ),
        );
        const finalDiagnostics = strictDiagnostics(diagnostics, input.strict === true);
        return {
          diagnostics: finalDiagnostics,
          exitCode: EXIT_CODES.USER_DECLINED,
          metadata: { profile: input.profile, sideEffects },
        };
      }
      const patch = parseCanonicalYaml(profile.facts.patch, { allowJsTag: true });
      if (
        profile.facts.patch.trim().length === 0 ||
        !patch.ok ||
        !Array.isArray(patch.value?.value)
      )
        diagnostics.push(
          profileDiagnostic(
            'DSH008',
            'cordis.patch.yml 必须是非空 YAML 顶层 array。',
            '合法空 patch 写为 []。',
            join(profile.facts.root, 'cordis.patch.yml'),
          ),
        );
      await fixEmptyPatch(profile.facts, input, diagnostics);
      await checkBundles(profile.facts, input, diagnostics);
      const dump = await runDsh(['--profile', input.profile, '--dump-default-config'], {
        cwd: profile.facts.root,
        dshHome: input.dshHome,
        timeout: 5_000,
        ...dshOptions(input),
      }).catch(() => undefined);
      if (dump !== undefined)
        diagnostics.push(
          ...preparePatchExport(dump.stdout, profile.facts.patch).diagnostics.map((item) => ({
            ...item,
            code: 'DSH009',
          })),
        );
      for (const root of [join(input.dshHome, 'skills'), join(input.dshHome, '.agent-presets')])
        for (const path of await markdownFiles(root)) {
          const source = await text(path);
          if (source === undefined) continue;
          const lint = inspectSkill(source, path);
          diagnostics.push(...lint);
          if (lint.some(({ code }) => code === 'DSH010'))
            await fixSkillName(path, source, input, diagnostics);
        }
      diagnostics.push(
        ...scanSecrets({ path: profile.facts.root }).map((item) => ({ ...item, code: 'DSH014' })),
      );
      diagnostics.push(
        diagnostic(
          'DSH015',
          'info',
          'profile 自身没有可验证的 pack.lock payload；安装记录可在 M1 做完整性复查。',
          '对 export 产物执行 dshpack validate --strict。',
        ),
      );
      if (version !== undefined)
        diagnostics.push(
          diagnostic(
            'DSH016',
            'info',
            '当前 profile 未保存 pack 的 dsh.tested 元数据。',
            `当前 dsh: ${version}`,
          ),
        );
      diagnostics.push(
        diagnostic(
          'DSH017',
          'info',
          '插件集变更需重启 dsh；preset 只对新 session 生效。',
          '在新 dsh 进程和新 session 中验证。',
        ),
      );
    }
  }
  await checkSettings(input.dshHome, diagnostics);
  const finalDiagnostics = strictDiagnostics(diagnostics, input.strict === true);
  return {
    diagnostics: finalDiagnostics,
    exitCode: doctorExit(finalDiagnostics),
    metadata: { ...(input.profile === undefined ? {} : { profile: input.profile }), sideEffects },
  };
}
