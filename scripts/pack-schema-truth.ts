import { PackLockSchema, PackManifestSchema } from '../packages/core/src/contracts.ts';

process.stdout.write(
  `${JSON.stringify({ pack: PackManifestSchema, lock: PackLockSchema }, null, 2)}\n`,
);
