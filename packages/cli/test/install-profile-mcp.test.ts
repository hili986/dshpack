import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCanonicalYaml } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';

import { installPack } from '../src/install/engine.js';
import { type ProfileMcpDeclaration, renderProfilePatch } from '../src/install/profile-mcp.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install manifest MCP application', () => {
  it('materializes each reviewed manifest MCP into the installed profile patch', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'dshpack-mcp-home-'));
    roots.push(dshHome);
    const source = await enginePack({ mcp: true });

    const report = await installPack(
      { source, dshHome, yes: true, interactive: false },
      fakeRuntime().runtime,
    );

    expect(report.exitCode).toBe(0);
    const patchText = await readFile(
      join(dshHome, 'profiles', 'engine-pack', 'cordis.patch.yml'),
      'utf8',
    );
    const parsed = parseCanonicalYaml(patchText);
    expect(parsed.ok).toBe(true);
    const rows = parsed.value?.value as Array<{ insert?: unknown[] }>;
    expect(rows.flatMap((row) => row.insert ?? [])).toEqual([
      {
        id: 'mcp-docs',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'docs',
          transport: 'streamable-http',
          url: 'https://mcp.example/docs',
        },
      },
    ]);
  });

  it('preserves the original patch bytes when the manifest has no MCP', () => {
    const patch = '# user comment\n- id: external\n  disabled: true\n';
    expect(renderProfilePatch(patch, [])).toBe(patch);
  });

  it('preserves an exact declared MCP already present in an exported patch', () => {
    const patch = [
      '# keep this comment',
      '- insert:',
      '    - id: existing-docs',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: docs',
      '        transport: streamable-http',
      '        url: https://mcp.example/docs',
      '        failOnStartupError: true',
      '',
    ].join('\n');
    expect(
      renderProfilePatch(patch, [
        { serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' },
      ]),
    ).toBe(patch);
  });

  it.each([
    {
      name: 'undeclared MCP',
      patch:
        "- insert:\n    - id: hidden\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: { serverName: hidden, transport: streamable-http, url: https://hidden.example/mcp }\n",
      mcp: [],
      code: 'E_MCP_PATCH_UNDECLARED',
    },
    {
      name: 'conflicting URL',
      patch:
        "- insert:\n    - id: existing-docs\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: { serverName: docs, transport: streamable-http, url: https://other.example/mcp }\n",
      mcp: [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' }],
      code: 'E_MCP_PATCH_CONFLICT',
    },
    {
      name: 'duplicate server',
      patch: [
        '- insert:',
        "    - { id: docs-one, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: docs, transport: streamable-http, url: https://mcp.example/docs } }",
        '- insert:',
        "    - { id: docs-two, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: docs, transport: streamable-http, url: https://mcp.example/docs } }",
        '',
      ].join('\n'),
      mcp: [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' }],
      code: 'E_MCP_PATCH_DUPLICATE',
    },
    {
      name: 'generated id collision',
      patch: '- insert:\n    - { id: mcp-docs, name: unrelated }\n',
      mcp: [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' }],
      code: 'E_MCP_PATCH_ID',
    },
    {
      name: 'duplicate inserted id',
      patch: '- insert:\n    - { id: duplicate, name: one }\n    - { id: duplicate, name: two }\n',
      mcp: [],
      code: 'E_MCP_PATCH_ID',
    },
    {
      name: 'non-array top level',
      patch: '{}\n',
      mcp: [],
      code: 'E_MCP_PATCH_TOP_LEVEL',
    },
    {
      name: 'malformed YAML',
      patch: '[\n',
      mcp: [],
      code: 'E_YAML_PARSE',
    },
    {
      name: 'non-mapping patch row',
      patch: '- invalid\n',
      mcp: [],
      code: 'E_MCP_PATCH_CONTRACT',
    },
    {
      name: 'non-array insert',
      patch: '- insert: invalid\n',
      mcp: [],
      code: 'E_MCP_PATCH_CONTRACT',
    },
    {
      name: 'non-mapping inserted row',
      patch: '- insert: [invalid]\n',
      mcp: [],
      code: 'E_MCP_PATCH_CONTRACT',
    },
    {
      name: 'missing MCP id',
      patch:
        "- insert:\n    - name: '@deepseek-ai/dsh-mcp-client'\n      config: { serverName: docs, transport: streamable-http, url: https://mcp.example/docs }\n",
      mcp: [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' }],
      code: 'E_MCP_PATCH_CONTRACT',
    },
    {
      name: 'empty MCP id',
      patch:
        "- insert:\n    - id: ''\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: { serverName: docs, transport: streamable-http, url: https://mcp.example/docs }\n",
      mcp: [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' }],
      code: 'E_MCP_PATCH_CONTRACT',
    },
    {
      name: 'non-mapping MCP config',
      patch:
        "- insert:\n    - { id: docs, name: '@deepseek-ai/dsh-mcp-client', config: invalid }\n",
      mcp: [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' }],
      code: 'E_MCP_PATCH_CONTRACT',
    },
    {
      name: 'invalid MCP fields',
      patch:
        "- insert:\n    - { id: docs, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 4, transport: stdio, url: 8 } }\n",
      mcp: [{ serverName: 'docs', transport: 'streamable-http', url: 'https://mcp.example/docs' }],
      code: 'E_MCP_PATCH_CONTRACT',
    },
  ] satisfies readonly {
    name: string;
    patch: string;
    mcp: readonly ProfileMcpDeclaration[];
    code: string;
  }[])('fails closed for $name', ({ patch, mcp, code }) => {
    expect(() => renderProfilePatch(patch, mcp)).toThrow(expect.objectContaining({ code }));
  });

  it('requires a second flag for a transitive physical package sharing the direct name', async () => {
    const source = await enginePack({ plugin: { allowBuilds: true } });
    const oneFlagHome = await mkdtemp(join(tmpdir(), 'dshpack-build-home-'));
    roots.push(oneFlagHome);
    const oneFlag = await installPack(
      {
        source,
        dshHome: oneFlagHome,
        yes: true,
        allowBuilds: ['example-bundle'],
        interactive: false,
      },
      fakeRuntime({ transitive: ['example-bundle'] }).runtime,
    );

    expect(oneFlag.exitCode).toBe(21);
    expect(oneFlag.diagnostics[0]?.hint?.match(/--allow-build 'example-bundle'/gu)).toHaveLength(2);

    const twoFlagHome = await mkdtemp(join(tmpdir(), 'dshpack-build-home-'));
    roots.push(twoFlagHome);
    const fake = fakeRuntime({ transitive: ['example-bundle'] });
    const twoFlags = await installPack(
      {
        source,
        dshHome: twoFlagHome,
        yes: true,
        allowBuilds: ['example-bundle', 'example-bundle'],
        interactive: false,
      },
      fake.runtime,
    );
    expect(twoFlags.exitCode).toBe(0);
    expect(fake.calls).toContain('pnpm:rebuild example-bundle');
  });
});
