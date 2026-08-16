import { join } from 'node:path';

import type { PackLockedPlugin, PluginDeclaration } from '@dshpack/core';

import { EXIT_CODES } from '../exit-codes.js';
import type { TransactionContext } from '../transaction.js';
import { guardedInstall, installFailure, runInstallFault } from './engine-errors.js';
import { nonInteractiveInstallArgv, nonInteractiveInstallCommand } from './policy.js';
import { exactPluginAddSpec, type InstalledPluginFact } from './profile-plugin.js';
import { buildAuthorizationKey } from './profile-workspace.js';
import type { ValidatedPackMaterial } from './read.js';
import type { InstallInput, InstallRuntime } from './runtime-types.js';
import type { InstallPlan } from './types.js';

export interface InstallReplayCommand {
  argv: readonly string[];
  powerShell: string;
}

function buildReplay(
  input: InstallInput,
  plan: InstallPlan,
  missing: readonly string[],
): InstallReplayCommand {
  const approved = [...new Set([...(input.allowBuilds ?? []), ...missing])];
  const direct = new Set(plan.allowBuilds);
  const replayPlan = {
    ...plan,
    extraBuildApprovals: [
      ...new Set([...plan.extraBuildApprovals, ...approved.filter((name) => !direct.has(name))]),
    ],
  };
  const options = { ...input, allowBuilds: approved, sourceArgument: input.source };
  const environment = { dshHome: plan.dshHome };
  return {
    argv: nonInteractiveInstallArgv(options, replayPlan, environment),
    powerShell: nonInteractiveInstallCommand(options, replayPlan, environment),
  };
}

async function auditBuilds(
  input: InstallInput,
  runtime: InstallRuntime,
  plan: InstallPlan,
  material: ValidatedPackMaterial,
  profileRoot: string,
  approvals: Set<string>,
  replay: { current?: InstallReplayCommand },
): Promise<void> {
  const audit = await guardedInstall(
    EXIT_CODES.POST_INSTALL_OR_ROLLBACK_FAILURE,
    'E_BUILD_AUDIT',
    '安装后的构建脚本审计失败。',
    () => runtime.auditInstalledBuildScripts(profileRoot, material.manifest.plugins, approvals),
  );
  if (audit.unapprovedDirectBuildKeys.length > 0)
    throw installFailure(
      EXIT_CODES.POST_INSTALL_OR_ROLLBACK_FAILURE,
      'E_BUILD_DIRECT',
      '直接插件构建授权未精确生效。',
      '停止安装并审计 workspace。',
    );
  const missing = audit.unexpectedTransitiveBuildKeys.filter((key) => !approvals.has(key));
  for (const key of missing) {
    replay.current = buildReplay(input, plan, missing);
    if (!input.interactive || input.json === true)
      throw installFailure(
        EXIT_CODES.USER_DECLINED,
        'E_BUILD_TRANSITIVE',
        '传递依赖要求执行构建脚本。',
        `运行完整非交互命令：${replay.current.powerShell}`,
      );
    if (
      !(await guardedInstall(
        EXIT_CODES.USER_DECLINED,
        'E_BUILD_CONFIRM',
        `无法确认 ${key} 构建授权。`,
        () => runtime.confirm({ kind: 'allow-build', subject: key, defaultValue: false }),
      ))
    )
      throw installFailure(
        EXIT_CODES.USER_DECLINED,
        'E_BUILD_TRANSITIVE',
        '用户拒绝传递依赖构建授权。',
        `运行完整非交互命令：${replay.current.powerShell}`,
      );
    approvals.add(key);
  }
  for (const key of audit.unexpectedTransitiveBuildKeys) {
    await guardedInstall(EXIT_CODES.CONTRACT, 'E_BUILD_AUTHORIZE', `无法精确授权 ${key}。`, () =>
      runtime.authorizeBuild(profileRoot, key),
    );
    await guardedInstall(
      EXIT_CODES.DSH_SUBPROCESS_FAILURE,
      'E_BUILD_REBUILD',
      `pnpm rebuild ${key} 失败。`,
      () => runtime.runPnpm(['rebuild', key], { dshHome: input.dshHome, cwd: profileRoot }),
    );
  }
  const verified = await guardedInstall(
    EXIT_CODES.POST_INSTALL_OR_ROLLBACK_FAILURE,
    'E_BUILD_REVERIFY',
    '构建脚本复验失败。',
    () => runtime.auditInstalledBuildScripts(profileRoot, material.manifest.plugins, approvals),
  );
  const unknown = verified.unexpectedTransitiveBuildKeys.filter((key) => !approvals.has(key));
  if (verified.unapprovedDirectBuildKeys.length > 0 || unknown.length > 0)
    throw installFailure(
      EXIT_CODES.POST_INSTALL_OR_ROLLBACK_FAILURE,
      'E_BUILD_REVERIFY',
      '构建脚本复验发现未授权条目。',
      '停止并人工审计依赖闭包。',
    );
}

function materialText(material: ValidatedPackMaterial, path: string): string {
  const encoded = material.files.find((file) => file.path === path)?.contentBase64;
  if (encoded === undefined)
    throw installFailure(
      EXIT_CODES.CONTRACT,
      'E_INSTALL_PAYLOAD',
      `验证快照缺少 ${path}。`,
      '重新验证 pack。',
    );
  return Buffer.from(encoded, 'base64').toString('utf8');
}

export async function installProfile(
  input: InstallInput,
  runtime: InstallRuntime,
  transaction: TransactionContext,
  plan: InstallPlan,
  material: ValidatedPackMaterial,
  approvals: Set<string>,
  replay: { current?: InstallReplayCommand },
): Promise<InstalledPluginFact[]> {
  const profileRoot = join(input.dshHome, 'profiles', plan.targetProfile);
  const facts: InstalledPluginFact[] = [];
  if (plan.replaceExistingProfile) await transaction.replaceProfile(profileRoot);
  await transaction.create('profile', profileRoot, async () => {
    await guardedInstall(
      EXIT_CODES.DSH_SUBPROCESS_FAILURE,
      'E_PROFILE_INIT',
      'dsh profile 初始化失败。',
      () =>
        runtime.runDsh(['plugin', '--profile', plan.targetProfile, 'list', '--depth=0'], {
          dshHome: input.dshHome,
          cwd: profileRoot,
        }),
    );
    await runInstallFault(runtime, 'init');
    await guardedInstall(
      EXIT_CODES.POST_INSTALL_OR_ROLLBACK_FAILURE,
      'E_PROFILE_INIT_VERIFY',
      '官方 profile 初始化契约漂移。',
      () => runtime.verifyOfficialProfileInit(profileRoot, plan.targetProfile),
    );
    for (let index = 0; index < material.manifest.plugins.length; index += 1) {
      const plugin = material.manifest.plugins[index] as PluginDeclaration;
      const locked = material.lock.plugins[index] as PackLockedPlugin;
      const planned = plan.plugins[index] as InstallPlan['plugins'][number];
      if (plugin.allowBuilds) {
        if (!approvals.has(plugin.name))
          throw installFailure(
            EXIT_CODES.USER_DECLINED,
            'E_BUILD_DIRECT',
            `缺少 ${plugin.name} 构建授权。`,
            `运行完整非交互命令：${buildReplay(input, plan, [plugin.name]).powerShell}`,
          );
        const key = buildAuthorizationKey(plugin);
        approvals.add(key);
        await guardedInstall(
          EXIT_CODES.CONTRACT,
          'E_BUILD_AUTHORIZE',
          `无法精确授权 ${plugin.name}。`,
          () => runtime.authorizeBuild(profileRoot, key),
        );
      }
      const download =
        plugin.source.kind === 'tarball'
          ? await guardedInstall(
              EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
              'E_PLUGIN_STAGE',
              `插件 ${plugin.name} 暂存失败。`,
              () => runtime.stagePluginTarball(plugin, locked, transaction.backupDirectory),
            )
          : undefined;
      try {
        const spec =
          download === undefined
            ? planned.exactSpec
            : await guardedInstall(
                EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
                'E_PLUGIN_STAGE_VERIFY',
                `插件 ${plugin.name} 暂存事实不匹配。`,
                () => exactPluginAddSpec(plugin, locked, download.staged),
              );
        await guardedInstall(
          EXIT_CODES.DSH_SUBPROCESS_FAILURE,
          'E_PLUGIN_ADD',
          `插件 ${plugin.name} 安装失败。`,
          () =>
            runtime.runDsh(['plugin', '--profile', plan.targetProfile, 'add', spec], {
              dshHome: input.dshHome,
              cwd: profileRoot,
            }),
        );
        await runInstallFault(runtime, 'add');
        facts.push(
          await guardedInstall(
            EXIT_CODES.POST_INSTALL_OR_ROLLBACK_FAILURE,
            'E_PLUGIN_VERIFY',
            `插件 ${plugin.name} 安装事实不匹配。`,
            () => runtime.verifyInstalledPlugin(profileRoot, plugin, locked),
          ),
        );
      } finally {
        if (download !== undefined)
          await guardedInstall(
            EXIT_CODES.SOURCE_NETWORK_INTEGRITY,
            'E_PLUGIN_CLEANUP',
            '插件暂存清理失败。',
            download.cleanup,
          );
      }
    }
    await runInstallFault(runtime, 'verify');
    await auditBuilds(input, runtime, plan, material, profileRoot, approvals, replay);
    await guardedInstall(
      EXIT_CODES.CONTRACT,
      'E_PROFILE_PATCH_WRITE',
      'profile patch 写入失败。',
      () =>
        runtime.atomicWriteText(
          join(profileRoot, 'cordis.patch.yml'),
          materialText(material, 'patch/cordis.patch.yml'),
        ),
    );
  });
  return facts;
}
