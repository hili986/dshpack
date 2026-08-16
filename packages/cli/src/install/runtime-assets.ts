import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { compareAndSwapText } from '../adapters/settings.js';
import { InstallProfileError } from './profile-common.js';
import { readAtomicFile } from './profile-fs.js';
import { updateWorkspaceAllowBuildKey } from './profile-workspace.js';
import type { ValidatedPackMaterial } from './read.js';

function relativeAssetPath(
  source: string,
  path: string,
  kind: 'skill' | 'preset',
): string | undefined {
  if (source.endsWith('.md')) {
    if (path !== source) return undefined;
    return kind === 'skill' ? 'SKILL.md' : path.split('/').at(-1);
  }
  const prefix = `${source}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function assertRelative(path: string): string[] {
  const segments = path.split('/');
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\\'),
    )
  )
    throw new InstallProfileError('E_ASSET_PATH', `asset 快照路径不安全：${path}`);
  return segments;
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Materialize only bytes already bound into ValidatedPackMaterial; SOURCE is never re-read. */
export async function writeMaterialAssetSnapshot(
  material: ValidatedPackMaterial,
  source: string,
  target: string,
  kind: 'skill' | 'preset',
): Promise<void> {
  const selected = material.files.flatMap((file) => {
    const relative = relativeAssetPath(source, file.path, kind);
    return relative === undefined ? [] : [{ file, relative }];
  });
  if (selected.length === 0)
    throw new InstallProfileError('E_ASSET_SOURCE', `验证快照缺少 asset：${source}`);
  for (const { file, relative } of selected) {
    const destination = join(target, ...assertRelative(relative));
    await writeExclusive(destination, Buffer.from(file.contentBase64, 'base64'));
  }
}

/** Comment-preserving exact-key CAS for both direct and second-confirmed transitive builds. */
export async function authorizeWorkspaceBuild(
  profileRoot: string,
  authorizationKey: string,
): Promise<void> {
  const path = join(profileRoot, 'pnpm-workspace.yaml');
  const source = (await readAtomicFile(path, 'E_WORKSPACE_YAML')).bytes.toString('utf8');
  const replacement = updateWorkspaceAllowBuildKey(source, authorizationKey);
  if (replacement === source) return;
  const changed = await compareAndSwapText(path, source, replacement);
  if (!changed.ok || changed.value !== true)
    throw new InstallProfileError(
      'E_WORKSPACE_CHANGED',
      'pnpm-workspace.yaml 在 allowBuilds RMW 期间变化。',
      path,
    );
}
