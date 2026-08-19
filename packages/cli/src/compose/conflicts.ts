import type { Diagnostic } from '@dshpack/core';

import { diagnostic } from '../commands/shared.js';
import type { ComposeResolution, ComposeSourceItem } from './schema.js';

export interface ResolvedComposeItem extends ComposeSourceItem {
  id: string;
}

function conflictMessage(id: string, items: readonly ComposeSourceItem[]): string {
  return `skill ${id} 存在多个来源: ${[...new Set(items.map(({ from }) => from))].join(', ')}`;
}

/** Resolve source-level ID conflicts. Multiple files from one source skill are one candidate. */
export function resolveComposeConflicts(
  items: readonly ComposeSourceItem[],
  resolutions: readonly ComposeResolution[],
): { diagnostics: Diagnostic[]; items: ResolvedComposeItem[] } {
  const byId = new Map<string, ComposeSourceItem[]>();
  for (const item of items) byId.set(item.id, [...(byId.get(item.id) ?? []), item]);
  const resolutionMap = new Map(resolutions.map((resolution) => [resolution.id, resolution]));
  const diagnostics: Diagnostic[] = [];
  const output: ResolvedComposeItem[] = [];
  for (const [id, candidates] of byId) {
    const sources = [...new Set(candidates.map(({ from }) => from))];
    const resolution = resolutionMap.get(id);
    if (sources.length === 1) {
      if (resolution?.rename !== undefined) {
        output.push(...candidates.map((item) => ({ ...item, id: resolution.rename as string })));
        diagnostics.push(
          diagnostic(
            'W_COMPOSE_RENAME',
            'warning',
            `已将 ${sources[0]} 的素材从 ${id} 改名为 ${resolution.rename}。`,
            '改名不会修改素材内容。',
            id,
          ),
        );
      } else if (resolution?.prefer !== undefined && resolution.prefer !== sources[0]) {
        diagnostics.push(
          diagnostic(
            'E_COMPOSE_RESOLVE_SOURCE',
            'error',
            `resolve.prefer 未匹配 skill ${id} 的来源: ${resolution.prefer}。`,
            `可选来源: ${sources.join(', ')}`,
            id,
          ),
        );
      } else {
        output.push(...candidates.map((item) => ({ ...item, id })));
      }
      continue;
    }
    if (resolution === undefined) {
      diagnostics.push(
        diagnostic(
          'E_COMPOSE_CONFLICT',
          'error',
          conflictMessage(id, candidates),
          '在 resolve 中明确使用 rename 或 prefer。',
          id,
        ),
      );
      continue;
    }
    if (resolution.prefer !== undefined) {
      const selected = candidates.filter(({ from }) => from === resolution.prefer);
      if (selected.length === 0) {
        diagnostics.push(
          diagnostic(
            'E_COMPOSE_RESOLVE_SOURCE',
            'error',
            `resolve.prefer 未匹配 skill ${id} 的任何来源: ${resolution.prefer}。`,
            `可选来源: ${sources.join(', ')}`,
            id,
          ),
        );
      } else {
        output.push(...selected.map((item) => ({ ...item, id })));
        diagnostics.push(
          diagnostic(
            'W_COMPOSE_PREFER',
            'warning',
            `${conflictMessage(id, candidates)}；已显式选择 ${resolution.prefer}。`,
            '未选中的来源不会进入产出。',
            id,
          ),
        );
      }
      continue;
    }
    const renamedSource = sources[0] as string;
    const renamed = resolution.rename as string;
    output.push(
      ...candidates.map((item) => ({ ...item, id: item.from === renamedSource ? renamed : id })),
    );
    diagnostics.push(
      diagnostic(
        'W_COMPOSE_RENAME',
        'warning',
        `${conflictMessage(id, candidates)}；已将 ${renamedSource} 的素材改名为 ${renamed}。`,
        '改名不会修改素材内容。',
        id,
      ),
    );
  }
  const byTarget = new Map<string, ResolvedComposeItem[]>();
  for (const item of output) byTarget.set(item.id, [...(byTarget.get(item.id) ?? []), item]);
  for (const [id, candidates] of byTarget) {
    if (new Set(candidates.map(({ from }) => from)).size > 1) {
      diagnostics.push(
        diagnostic(
          'E_COMPOSE_CONFLICT',
          'error',
          conflictMessage(id, candidates),
          '为所有冲突 id 提供不重叠的 resolve。',
          id,
        ),
      );
    }
  }
  return {
    diagnostics,
    items: diagnostics.some(({ severity }) => severity === 'error') ? [] : output,
  };
}
