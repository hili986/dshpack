import { type Diagnostic, parseCanonicalYaml } from '@dshpack/core';

import { prepareAgentPresetsMerge } from '../adapters/settings.js';
import type { ValidatedPackMaterial } from './read.js';

export function diagnostic(code: string, message: string, hint: string, path?: string): Diagnostic {
  return {
    code,
    severity: 'error',
    message,
    hint,
    evidence: 'local',
    ...(path === undefined ? {} : { path }),
  };
}

function materialText(material: ValidatedPackMaterial, path: string): string | undefined {
  const encoded = material.files.find((file) => file.path === path)?.contentBase64;
  return encoded === undefined ? undefined : Buffer.from(encoded, 'base64').toString('utf8');
}

export function contentFailure(material: ValidatedPackMaterial): Diagnostic | undefined {
  if (material.manifest.settings !== undefined) {
    if (material.manifest.settings.namespaces['agent-presets'] !== 'agent-presets.yml') {
      return diagnostic(
        'E_SETTINGS_SOURCE',
        'v0 settings namespace 必须引用 settings/agent-presets.yml。',
        '将 agent-presets 映射值改为 agent-presets.yml。',
      );
    }
    const fragment = materialText(material, 'settings/agent-presets.yml');
    if (fragment === undefined) {
      return diagnostic(
        'E_SETTINGS_SOURCE_MISSING',
        'manifest 声明了 agent-presets settings，但 payload 文件不存在。',
        '提供 settings/agent-presets.yml 并将其加入 lock.files。',
        'settings/agent-presets.yml',
      );
    }
    const prepared = prepareAgentPresetsMerge({
      currentDocument: undefined,
      fragment,
      settingsPath: 'settings.yaml',
      fragmentPath: 'settings/agent-presets.yml',
    });
    if (!prepared.ok) return prepared.diagnostics[0];
  }
  for (const path of material.paths.filter((entry) => /^presets\/[^/]+\/.+\.ya?ml$/u.test(entry))) {
    const source = materialText(material, path);
    if (source === undefined) continue;
    const parsed = parseCanonicalYaml(source, { allowJsTag: path.endsWith('agent.cordis.yml') });
    if (!parsed.ok || (path.endsWith('agent.cordis.yml') && !Array.isArray(parsed.value?.value))) {
      return diagnostic(
        'E_PRESET_YAML',
        `preset YAML 无效：${path}`,
        '修复 YAML；agent.cordis.yml 顶层必须是 array。',
        path,
      );
    }
  }
  return undefined;
}
