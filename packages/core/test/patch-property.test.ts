import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { composePatch, emitMinimalWholeRowPatch, parseCanonicalYaml } from '../src/index.js';

const defaultDump = readFileSync(
  resolve(import.meta.dirname, 'fixtures', 'real-dsh', 'e9', 'dump-default-config.yml'),
  'utf8',
);
const parsed = parseCanonicalYaml(defaultDump, { allowJsTag: true });
if (!parsed.ok || !Array.isArray(parsed.value?.value)) {
  throw new Error('E9 default dump fixture must remain a valid entry array');
}

const base = parsed.value.value as Record<string, unknown>[];
const targetIds = base.flatMap((row) => (typeof row.id === 'string' ? [row.id] : []));

describe('patch round-trip property', () => {
  it('checks 100 generated non-js row mutations of the real E9 dump', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...targetIds),
        fc.jsonValue(),
        fc.boolean(),
        fc.array(
          fc.record({
            suffix: fc.stringMatching(/^[a-z0-9]{1,12}$/),
            config: fc.jsonValue(),
          }),
          { maxLength: 3 },
        ),
        (targetId, config, disabled, additions) => {
          const desired = structuredClone(base);
          const target = desired.find((row) => row.id === targetId);
          expect(target).toBeDefined();
          if (target === undefined) return;
          target.config = config;
          target.disabled = disabled;

          const usedIds = new Set(desired.map((row) => row.id));
          for (const [index, addition] of additions.entries()) {
            const id = `property-${index}-${addition.suffix}`;
            if (usedIds.has(id)) continue;
            usedIds.add(id);
            desired.push({ id, name: `property-plugin-${index}`, config: addition.config });
          }

          const emitted = emitMinimalWholeRowPatch(base, desired);
          expect(emitted.ok).toBe(true);
          expect(composePatch(base, emitted.value ?? []).value).toEqual(desired);
        },
      ),
      { numRuns: 100 },
    );
    console.info('W7_FAST_CHECK_RUNS {"numRuns":100,"fixture":"e9/dump-default-config.yml"}');
  });
});
