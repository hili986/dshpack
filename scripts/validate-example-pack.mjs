import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const packRoot = resolve('examples/packs/minimal');
const packFile = resolve(packRoot, 'pack.yml');

const rootStat = await stat(packRoot);
if (!rootStat.isDirectory()) {
  throw new Error(`示例 pack 路径不是目录：${packRoot}`);
}

const document = parse(await readFile(packFile, 'utf8'));
if (document === null || typeof document !== 'object' || Array.isArray(document)) {
  throw new Error('examples/packs/minimal/pack.yml 必须解析为 YAML mapping');
}

console.log('pack:validate: examples/packs/minimal/pack.yml YAML 解析成功');
