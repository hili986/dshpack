import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { composePatch, parseCanonicalYaml } from '@dshpack/core';
import { afterEach, describe, expect, it } from 'vitest';
import { exportProfile } from '../src/export/engine.js';
import { validateLocalPack } from '../src/validation/validate-pack.js';

const temporaryRoots: string[] = [];

async function profileFixture(): Promise<{ home: string; output: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dshpack-export-home-'));
  temporaryRoots.push(home);
  const profile = join(home, 'profiles', 'demo');
  const bundle = join(profile, 'node_modules', 'demo-bundle');
  await mkdir(bundle, { recursive: true });
  await mkdir(join(home, 'skills', 'demo-skill'), { recursive: true });
  await mkdir(join(home, '.agent-presets', 'demo-preset'), { recursive: true });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'dsh-profile-demo',
      private: true,
      dependencies: { 'demo-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-bundle'] } },
    }),
    'utf8',
  );
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    `- insert:
    - id: mcp-demo
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: demo-mcp
        transport: streamable-http
        url: https://mcp.example.test/mcp
`,
    'utf8',
  );
  await writeFile(
    join(profile, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      demo-bundle: {specifier: 1.0.0, version: 1.0.0}
packages:
  demo-bundle@1.0.0: {resolution: {integrity: sha512-AQID}}
`,
    'utf8',
  );
  await writeFile(
    join(bundle, 'package.json'),
    JSON.stringify({
      name: 'demo-bundle',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
    'utf8',
  );
  await writeFile(
    join(home, 'skills', 'demo-skill', 'SKILL.md'),
    '---\nname: demo-skill\ndescription: export test\n---\nbody\n',
    'utf8',
  );
  await writeFile(
    join(home, '.agent-presets', 'demo-preset', 'agent.cordis.yml'),
    'agents: []\n',
    'utf8',
  );
  await writeFile(
    join(home, 'settings.yaml'),
    'agent-presets:\n  selected: sk-TESTONLY-012345678901234567890123\n',
    'utf8',
  );
  const shim = join(home, 'PATH first shim');
  await mkdir(shim);
  await writeFile(
    join(shim, 'export-shim.mjs'),
    `const argv = process.argv.slice(2);\nprocess.stdout.write(argv.includes('--version') ? '0.1.0-rc.6\\n' : '[]\\n');\nprocess.exitCode = Number(process.env.EXPORT_SHIM_EXIT ?? 0);\n`,
    'utf8',
  );
  if (process.platform === 'win32') {
    await writeFile(
      join(shim, 'dsh.cmd'),
      `@echo off\n"%DSHPACK_NODE_EXE%" "%~dp0export-shim.mjs" %*\n`,
      'utf8',
    );
  } else {
    await writeFile(
      join(shim, 'dsh'),
      "#!/usr/bin/env node\nawait import('./export-shim.mjs');\n",
      'utf8',
    );
    await chmod(join(shim, 'dsh'), 0o755);
  }
  return { home, output: join(dirname(home), `${basename(home)}-pack`) };
}

function environment(home: string): NodeJS.ProcessEnv {
  return {
    DSHPACK_NODE_EXE: process.execPath,
    PATH: [join(home, 'PATH first shim'), process.env.PATH ?? dirname(process.execPath)].join(
      delimiter,
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('export end-to-end with a temporary DSH_HOME and PATH-first dsh shim', () => {
  it('rejects missing profile, missing profile files, and an unconfirmed existing output', async () => {
    const { home, output } = await profileFixture();
    await expect(
      exportProfile({ dshHome: home, output, env: environment(home) }),
    ).resolves.toMatchObject({
      exitCode: 2,
    });
    await expect(
      exportProfile({ dshHome: home, profile: 'absent', output, env: environment(home) }),
    ).resolves.toMatchObject({
      exitCode: 30,
    });
    await mkdir(output);
    await expect(
      exportProfile({ dshHome: home, profile: 'demo', output, env: environment(home) }),
    ).resolves.toMatchObject({
      exitCode: 21,
    });
  });

  it('covers dsh failure, invalid patch, and missing lock branches without publishing output', async () => {
    const first = await profileFixture();
    await expect(
      exportProfile({
        dshHome: first.home,
        profile: 'demo',
        output: first.output,
        env: { ...environment(first.home), EXPORT_SHIM_EXIT: '1' },
      }),
    ).resolves.toMatchObject({ exitCode: 23 });

    const second = await profileFixture();
    await writeFile(join(second.home, 'profiles', 'demo', 'cordis.patch.yml'), '', 'utf8');
    await expect(
      exportProfile({
        dshHome: second.home,
        profile: 'demo',
        output: second.output,
        env: environment(second.home),
      }),
    ).resolves.toMatchObject({ exitCode: 30 });

    const third = await profileFixture();
    await rm(join(third.home, 'profiles', 'demo', 'pnpm-lock.yaml'));
    await expect(
      exportProfile({
        dshHome: third.home,
        profile: 'demo',
        output: third.output,
        env: environment(third.home),
      }),
    ).resolves.toMatchObject({ exitCode: 30 });
    const fourth = await profileFixture();
    await rm(join(fourth.home, 'profiles', 'demo', 'pnpm-lock.yaml'));
    const unverified = await exportProfile({
      dshHome: fourth.home,
      profile: 'demo',
      output: fourth.output,
      allowUnverifiedExport: true,
      env: environment(fourth.home),
    });
    expect(unverified.metadata.integrity).toBe('unverified');
  });

  it('exports skills/preset/settings/MCP, redacts settings, self-validates, and preserves no forbidden payload', async () => {
    const { home, output } = await profileFixture();
    const result = await exportProfile({
      dshHome: home,
      profile: 'demo',
      output,
      includeSkills: true,
      includePresets: ['demo-preset'],
      includeSettings: true,
      redact: true,
      env: environment(home),
    });
    console.info(
      `EXPORT_VALIDATE ${JSON.stringify({ exitCode: result.exitCode, metadata: result.metadata, diagnostics: result.diagnostics })}`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.metadata.redactions).toEqual(['settings/agent-presets.yml']);
    const validation = await validateLocalPack(output, { strict: true });
    console.info(`EXPORT_STRICT_VALIDATE ${JSON.stringify(validation)}`);
    expect(validation).toMatchObject({ exitCode: 0 });
    await expect(
      readFile(join(output, 'settings', 'agent-presets.yml'), 'utf8'),
    ).resolves.toContain('<REDACTED>');
    await expect(readFile(join(output, 'export-report.json'), 'utf8')).resolves.toContain(
      'settings/agent-presets.yml',
    );
    const payloadNames = await Promise.all([
      readFile(join(output, '.credentials.yaml'), 'utf8')
        .then(() => true)
        .catch(() => false),
      readFile(join(output, 'pnpm-lock.yaml'), 'utf8')
        .then(() => true)
        .catch(() => false),
    ]);
    console.info(`EXPORT_FORBIDDEN_PAYLOAD ${JSON.stringify(payloadNames)}`);
    expect(payloadNames).toEqual([false, false]);
    const originalPatch = parseCanonicalYaml(
      await readFile(join(home, 'profiles', 'demo', 'cordis.patch.yml'), 'utf8'),
      { allowJsTag: true },
    );
    const emittedPatch = parseCanonicalYaml(
      await readFile(join(output, 'patch', 'cordis.patch.yml'), 'utf8'),
      { allowJsTag: true },
    );
    const expected = composePatch([], originalPatch.value?.value as unknown[]);
    const actual = composePatch([], emittedPatch.value?.value as unknown[]);
    const equal = JSON.stringify(expected.value) === JSON.stringify(actual.value);
    console.info(
      `EXPORT_PATCH_ROUNDTRIP ${JSON.stringify({ equal, emitted: emittedPatch.value?.value })}`,
    );
    expect(equal).toBe(true);
  });

  it('fails closed with exit 31 and does not echo a credential token from the profile', async () => {
    const { home, output } = await profileFixture();
    const token = 'sk-TESTONLY-098765432109876543210987654321';
    await writeFile(
      join(home, 'profiles', 'demo', '.credentials.yaml'),
      `token: ${token}\n`,
      'utf8',
    );
    const result = await exportProfile({
      dshHome: home,
      profile: 'demo',
      output,
      env: environment(home),
    });
    console.info(
      `EXPORT_SECRET_REJECT ${JSON.stringify({ exitCode: result.exitCode, diagnostics: result.diagnostics })}`,
    );

    expect(result.exitCode).toBe(31);
    expect(JSON.stringify(result.diagnostics)).not.toContain(token.slice(0, 8));
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_SECRET_FILENAME' }),
    );
  });
});
