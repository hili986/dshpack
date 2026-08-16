import { join } from 'node:path';

import { type Diagnostic, scanSecrets } from '@dshpack/core';
import { execa } from 'execa';
import { parseDocument } from 'yaml';

import { DshProcessError, runDsh } from '../adapters/process.js';
import { diagnostic } from '../commands/shared.js';
import {
  type DoctorInput,
  dshOptions,
  type ProfileFacts,
  profileDiagnostic,
  text,
  versionAtLeast,
} from './support.js';

export async function dshVersion(
  input: DoctorInput,
  diagnostics: Diagnostic[],
): Promise<string | undefined> {
  try {
    const result = await runDsh(['--version'], {
      cwd: input.dshHome,
      dshHome: input.dshHome,
      timeout: 5_000,
      ...dshOptions(input),
    });
    const version = result.stdout.replace(/\n$/u, '');
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) return version;
    diagnostics.push(
      profileDiagnostic(
        'DSH003',
        'dsh --version 输出不是已验证的 SemVer 格式。',
        '升级或修复 PATH 中的 dsh。',
      ),
    );
  } catch (error) {
    diagnostics.push(
      profileDiagnostic(
        'DSH003',
        '无法在 5 秒内执行 dsh --version。',
        '安装 dsh 或修复 PATH。',
        error instanceof DshProcessError ? error.logPath : undefined,
      ),
    );
  }
  return undefined;
}

export async function checkPnpm(input: DoctorInput, diagnostics: Diagnostic[]): Promise<void> {
  try {
    const result = await execa('pnpm', ['--version'], {
      cwd: input.dshHome,
      reject: false,
      shell: false,
      timeout: 5_000,
      windowsHide: true,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    const version = result.stdout.replace(/\n$/u, '');
    if (result.exitCode !== 0 || !versionAtLeast(version, [10, 0, 0]))
      diagnostics.push(
        profileDiagnostic('DSH002', 'pnpm 不可用或版本低于 10。', '安装 pnpm >=10。'),
      );
    else if (version.startsWith('11.'))
      diagnostics.push(
        diagnostic(
          'DSH002',
          'warning',
          'pnpm 11 的 git-spec 行为与旧版可能不同。',
          '导出 git bundle 时保留 40 位 SHA pin。',
        ),
      );
  } catch {
    diagnostics.push(profileDiagnostic('DSH002', 'pnpm 不在 PATH。', '安装 pnpm >=10。'));
  }
}

export async function checkBundles(
  facts: ProfileFacts,
  input: DoctorInput,
  diagnostics: Diagnostic[],
): Promise<void> {
  const external = facts.bundles.filter((name) => name !== '@deepseek-ai/dsh-base');
  for (const name of external)
    if (!Object.hasOwn(facts.dependencies, name))
      diagnostics.push(
        profileDiagnostic(
          'DSH006',
          'bundle 未出现在 profile dependencies。',
          '用 dsh plugin 重新安装该 bundle。',
          name,
        ),
      );
  for (const name of Object.keys(facts.dependencies)) {
    if (!facts.bundles.includes(name))
      diagnostics.push(
        profileDiagnostic(
          'DSH006',
          'dependency 未激活为 profile bundle。',
          '确认是否应加入 dsh.profile.bundles。',
          name,
        ),
      );
    const installed = await text(
      join(facts.root, 'node_modules', ...name.split('/'), 'package.json'),
    );
    if (installed === undefined) {
      diagnostics.push(
        profileDiagnostic(
          'DSH005',
          'dependency 未安装到 profile node_modules。',
          '运行 dsh plugin 安装或修复 profile。',
          name,
        ),
      );
      continue;
    }
    try {
      const packageJson = JSON.parse(installed) as { dsh?: { bundle?: { patch?: unknown } } };
      if (typeof packageJson.dsh?.bundle?.patch !== 'string')
        diagnostics.push(
          profileDiagnostic(
            'DSH005',
            'dependency 未声明 dsh.bundle.patch，安装后不会生效。',
            '使用声明 bundle patch 的包。',
            name,
          ),
        );
    } catch {
      diagnostics.push(
        profileDiagnostic(
          'DSH005',
          '已安装 dependency 的 package.json 不能解析。',
          '重新安装该 dependency。',
          name,
        ),
      );
    }
  }
  if (external.length === 0) return;
  try {
    await runDsh(['--profile', input.profile as string, '--dump-default-config'], {
      cwd: facts.root,
      dshHome: input.dshHome,
      timeout: 5_000,
      ...dshOptions(input),
    });
  } catch (error) {
    diagnostics.push(
      profileDiagnostic(
        'DSH006',
        '无法 dump bundle 基线，不能完成三方对账。',
        '修复 dsh profile 后重试。',
        error instanceof DshProcessError ? error.logPath : undefined,
      ),
    );
  }
}

export async function checkSettings(dshHome: string, diagnostics: Diagnostic[]): Promise<void> {
  const path = join(dshHome, 'settings.yaml');
  const source = await text(path);
  if (source === undefined) return;
  const document = parseDocument(source, { version: '1.2', uniqueKeys: true });
  if (document.errors.length > 0)
    diagnostics.push(
      profileDiagnostic('DSH018', 'settings.yaml YAML 无法解析。', '修复 settings YAML。', path),
    );
  const values = document.toJS();
  if (typeof values === 'object' && values !== null && !Array.isArray(values))
    for (const key of Object.keys(values))
      if (key !== 'agent-presets')
        diagnostics.push(
          profileDiagnostic(
            'DSH018',
            'settings 仅允许检查 agent-presets namespace。',
            '将其他 namespace 保持为 dsh 自身管理。',
            path,
          ),
        );
  diagnostics.push(
    ...scanSecrets({ path, content: source, settingsNamespace: 'agent-presets' }).map((item) => ({
      ...item,
      code: 'DSH018',
    })),
  );
  if ((await text(`${path}.lock`)) !== undefined)
    diagnostics.push(
      diagnostic(
        'DSH018',
        'warning',
        '检测到 settings.yaml.lock；不会抢删孤儿锁。',
        '确认持有进程后人工处理该锁。',
        `${path}.lock`,
      ),
    );
}
