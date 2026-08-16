import { createHash } from 'node:crypto';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { InstallProfileError } from './profile-common.js';
import { type ProfileReadHooks, readAtomicFile, requirePrivateDirectory } from './profile-fs.js';

export interface StagedPluginTarball {
  readonly path: string;
  readonly integrity: string;
  readonly identity: string;
}

function sha512(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function assertSri(value: string): void {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value))
    throw new InstallProfileError(
      'E_PLUGIN_TARBALL_INTEGRITY',
      'tarball integrity 不是 sha512 SRI。',
    );
}

/** Copy verified download bytes into a private, exclusive, unpredictable staging directory. */
export async function stageVerifiedPluginTarball(
  sourcePath: string,
  privateParent: string,
  expectedIntegrity: string,
  hooks: ProfileReadHooks = {},
): Promise<StagedPluginTarball> {
  assertSri(expectedIntegrity);
  if (!isAbsolute(sourcePath) || !sourcePath.endsWith('.tgz'))
    throw new InstallProfileError('E_PLUGIN_TARBALL_PATH', '下载物必须是绝对本地 .tgz 路径。');
  const source = await readAtomicFile(sourcePath, 'E_PLUGIN_TARBALL_PATH', hooks);
  if (sha512(source.bytes) !== expectedIntegrity)
    throw new InstallProfileError('E_PLUGIN_TARBALL_INTEGRITY', '下载物 sha512 与 lock 不一致。');
  const parent = await requirePrivateDirectory(privateParent, hooks);
  const directory = await mkdtemp(join(parent.canonical, 'dshpack-plugin-'));
  try {
    await chmod(directory, 0o700);
    const path = join(directory, 'plugin.tgz');
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(source.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const staged = await readAtomicFile(path, 'E_PLUGIN_TARBALL_CHANGED', hooks);
    if (sha512(staged.bytes) !== expectedIntegrity)
      throw new InstallProfileError('E_PLUGIN_TARBALL_INTEGRITY', '私有 staged tarball 校验失败。');
    return Object.freeze({ path, integrity: expectedIntegrity, identity: staged.identity });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Recheck pathname identity and content immediately before returning the spawn argument. */
export async function verifyStagedPluginTarball(
  staged: StagedPluginTarball,
  expectedIntegrity: string,
  hooks: ProfileReadHooks = {},
): Promise<string> {
  assertSri(expectedIntegrity);
  if (!isAbsolute(staged.path) || !staged.path.endsWith('.tgz'))
    throw new InstallProfileError('E_PLUGIN_TARBALL_PATH', 'staged tarball 路径无效。');
  if (staged.integrity !== expectedIntegrity)
    throw new InstallProfileError(
      'E_PLUGIN_TARBALL_INTEGRITY',
      'staged tarball SRI 标记与 lock 不一致。',
    );
  const current = await readAtomicFile(staged.path, 'E_PLUGIN_TARBALL_CHANGED', hooks);
  if (current.identity !== staged.identity)
    throw new InstallProfileError('E_PLUGIN_TARBALL_CHANGED', 'staged tarball 路径身份已改变。');
  if (sha512(current.bytes) !== expectedIntegrity)
    throw new InstallProfileError(
      'E_PLUGIN_TARBALL_INTEGRITY',
      'staged tarball 字节与 lock 不一致。',
    );
  return staged.path;
}
