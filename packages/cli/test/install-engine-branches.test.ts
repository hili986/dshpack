import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DshProcessError } from '../src/adapters/process.js';
import { SourceError } from '../src/adapters/source.js';
import { diagnostic } from '../src/commands/shared.js';
import { installPack } from '../src/install/engine.js';
import { InstallProfileError } from '../src/install/profile-common.js';
import { TransactionFailure } from '../src/transaction.js';
import { enginePack, fakeRuntime } from './install-engine-fixture.js';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshpack-engine-branches-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('install engine boundary branches', () => {
  it.each([
    ['materialize', 20, 'E_SOURCE'],
    ['read-source', 31, 'E_READ_SECURITY'],
    ['read-generic', 20, 'E_SOURCE_READ'],
    ['cleanup-generic', 20, 'E_SOURCE_CLEANUP'],
    ['probe', 10, 'E_PROBE'],
    ['capture', 31, 'E_TARGET_STATE'],
  ] as const)('classifies a %s pre-transaction failure', async (scenario, exitCode, code) => {
    const source = await enginePack();
    const fake = fakeRuntime();
    if (scenario === 'materialize') {
      fake.runtime.materializeSource = async () => {
        throw new Error('materialize mutant');
      };
    } else if (scenario === 'read-source') {
      fake.runtime.readValidatedPack = async () => {
        throw new SourceError('E_READ_SECURITY', 31, 'unsafe snapshot', 'remove junction');
      };
    } else if (scenario === 'read-generic') {
      fake.runtime.readValidatedPack = async () => {
        throw new Error('read mutant');
      };
    } else if (scenario === 'cleanup-generic') {
      const materialize = fake.runtime.materializeSource;
      fake.runtime.materializeSource = async (reference) => {
        const acquired = await materialize(reference);
        return {
          ...acquired,
          cleanup: async () => {
            throw new Error('cleanup mutant');
          },
        };
      };
    } else if (scenario === 'probe') {
      fake.runtime.probe = async () => {
        throw new Error('probe mutant');
      };
    } else {
      fake.runtime.captureTargetState = async () => {
        throw new Error('capture mutant');
      };
    }

    const result = await installPack(
      { source, dshHome: await home(), yes: true, interactive: false },
      fake.runtime,
    );
    expect(result).toMatchObject({ exitCode, metadata: { status: 'not-started' } });
    expect(result.diagnostics[0]?.code).toBe(code);
  });

  it('defaults every interactive prompt to refusal and grants a direct build only explicitly', async () => {
    const source = await enginePack({ plugin: { allowBuilds: true } });
    const declined = fakeRuntime({ confirmations: [false] });
    const no = await installPack(
      { source, dshHome: await home(), interactive: true },
      declined.runtime,
    );
    expect(no).toMatchObject({ exitCode: 21, metadata: { status: 'not-started' } });
    expect(no.diagnostics).toContainEqual(expect.objectContaining({ code: 'E_USER_DECLINED' }));
    expect(declined.calls).toContain('confirm:allow-build:example-bundle');

    const accepted = fakeRuntime({ confirmations: [true, true] });
    const yes = await installPack(
      { source, dshHome: await home(), interactive: true },
      accepted.runtime,
    );
    expect(yes.exitCode).toBe(0);
    expect(accepted.calls).toContain('allow-build:example-bundle');

    const brokenPrompt = fakeRuntime({ confirmations: [true] });
    brokenPrompt.runtime.confirm = async () => {
      throw new Error('prompt unavailable');
    };
    const canceled = await installPack(
      { source, dshHome: await home(), interactive: true },
      brokenPrompt.runtime,
    );
    expect(canceled).toMatchObject({ exitCode: 21, metadata: { status: 'not-started' } });
    expect(canceled.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'E_USER_DECLINED' }),
    );
  });

  it.each(['decline', 'accept', 'throw'] as const)(
    'requires an explicit interactive %s decision for a transitive build',
    async (decision) => {
      const fake = fakeRuntime({
        confirmations: decision === 'decline' ? [true, false] : [true, true],
        transitive: ['transitive-build'],
      });
      if (decision === 'throw') {
        let prompts = 0;
        fake.runtime.confirm = async () => {
          prompts += 1;
          if (prompts === 2) throw new Error('prompt mutant');
          return true;
        };
      }
      const result = await installPack(
        { source: await enginePack(), dshHome: await home(), interactive: true },
        fake.runtime,
      );
      expect(result.exitCode).toBe(decision === 'accept' ? 0 : 21);
      if (decision !== 'accept')
        expect(result.metadata.requiredCommand?.argv).toContain('transitive-build');
    },
  );

  it('treats json mode as non-interactive for a newly discovered build', async () => {
    const fake = fakeRuntime({ transitive: ['json-build'] });
    const result = await installPack(
      {
        source: await enginePack(),
        dshHome: await home(),
        yes: true,
        json: true,
        interactive: true,
      },
      fake.runtime,
    );
    expect(result.exitCode).toBe(21);
    expect(fake.stderr).toEqual([]);
    expect(fake.calls).not.toContainEqual(expect.stringMatching(/^confirm:/u));
  });

  it.each(['transaction', 'source', 'profile', 'process'] as const)(
    'preserves a typed %s failure from an apply operation',
    async (kind) => {
      const fake = fakeRuntime();
      let source = await enginePack();
      if (kind === 'transaction') {
        fake.runtime.runDoctor = async () => {
          throw new TransactionFailure(24, [diagnostic('E_TYPED_TX', 'error', 'typed', 'fix')]);
        };
      } else if (kind === 'source') {
        source = await enginePack({ plugin: { source: 'tarball' } });
        fake.runtime.stagePluginTarball = async () => {
          throw new SourceError('E_PLUGIN_NETWORK', 20, 'network rejected', 'use local clone');
        };
      } else if (kind === 'profile') {
        fake.runtime.verifyOfficialProfileInit = async () => {
          throw new InstallProfileError('E_INIT_FACT', 'profile files differ', 'package.json');
        };
      } else {
        fake.runtime.runDsh = async () => {
          throw new DshProcessError('dsh failed', {
            exitCode: 1,
            interrupted: false,
            interruptionReason: undefined,
            launcher: 'path',
            logPath: 'fixture.log',
            stderr: 'failed',
            stdout: '',
            timedOut: false,
          });
        };
      }
      const result = await installPack(
        { source, dshHome: await home(), yes: true, interactive: false },
        fake.runtime,
      );
      const expected = {
        transaction: 'E_TYPED_TX',
        source: 'E_PLUGIN_NETWORK',
        profile: 'E_INIT_FACT',
        process: 'E_DSH_SUBPROCESS',
      }[kind];
      expect(result.metadata.status).toBe('rolled-back');
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: expected }));
    },
  );

  it('uses and cleans a verified private tarball spec exactly once', async () => {
    const fake = fakeRuntime();
    const result = await installPack(
      {
        source: await enginePack({ plugin: { source: 'tarball' } }),
        dshHome: await home(),
        yes: true,
        interactive: false,
      },
      fake.runtime,
    );
    expect(result.exitCode).toBe(0);
    expect(fake.calls.filter((call) => call === 'cleanup:plugin')).toHaveLength(1);
    expect(
      fake.calls.find((call) => call.startsWith('dsh:plugin') && call.endsWith('.tgz')),
    ).toBeDefined();
  });

  it.each(['direct-audit', 'reverify', 'doctor-result', 'locked-drift'] as const)(
    'rolls back a post-install %s mismatch as exit 24/30',
    async (scenario) => {
      const fake = fakeRuntime();
      if (scenario === 'direct-audit') {
        fake.runtime.auditInstalledBuildScripts = async () => ({
          approvedDirect: [],
          transitive: [],
          unapprovedDirectBuildKeys: ['unexpected-direct'],
          unexpectedTransitiveBuildKeys: [],
        });
      } else if (scenario === 'reverify') {
        let audit = 0;
        fake.runtime.auditInstalledBuildScripts = async () => {
          audit += 1;
          return {
            approvedDirect: [],
            transitive: [],
            unapprovedDirectBuildKeys: [],
            unexpectedTransitiveBuildKeys: audit === 1 ? [] : ['late-build'],
          };
        };
      } else if (scenario === 'doctor-result') {
        fake.runtime.runDoctor = async () => ({
          diagnostics: [diagnostic('E_DOCTOR_RESULT', 'error', 'doctor red', 'fix')],
          exitCode: 30,
          metadata: {
            sideEffects: [
              { owner: 'dsh', path: 'profile/cordis.yml' },
              { owner: 'dshpack', path: '.dshpack/logs/<file>' },
            ],
          },
        });
      } else {
        const capture = fake.runtime.captureTargetState;
        let calls = 0;
        fake.runtime.captureTargetState = async (request) => {
          const value = await capture(request);
          calls += 1;
          return calls === 3 ? { ...value, digest: 'sha256-locked-drift' } : value;
        };
      }
      const result = await installPack(
        { source: await enginePack(), dshHome: await home(), yes: true, interactive: false },
        fake.runtime,
      );
      expect(result.exitCode).toBe(scenario === 'locked-drift' ? 30 : 24);
      expect(result.metadata.status).toBe('rolled-back');
    },
  );

  it('rolls back what this install owns and only reports what it does not', async () => {
    // doctor --strict grades the whole home. The two runs below differ in exactly one
    // character of one path: whether the identical DSH010 lands on the skill this pack
    // wrote or on one that was already there. Anything else that diverges is a defect.
    const graded = (path: string) => ({
      diagnostics: [diagnostic('DSH010', 'error', 'skill 缺少 name', '补 frontmatter', path)],
      exitCode: 30 as const,
      metadata: { sideEffects: [] },
    });

    const foreign = fakeRuntime();
    foreign.runtime.runDoctor = async ({ dshHome }) =>
      graded(join(dshHome, 'skills', 'someone-elses.md'));
    const keptHome = await home();
    const kept = await installPack(
      {
        source: await enginePack({ assets: true }),
        dshHome: keptHome,
        yes: true,
        interactive: false,
      },
      foreign.runtime,
    );

    // A flat pack skill normalizes into a directory skill, so the finding this install
    // owns lands at skills/notes/SKILL.md — asserted below against what was written.
    const mine = fakeRuntime();
    mine.runtime.runDoctor = async ({ dshHome }) =>
      graded(join(dshHome, 'skills', 'notes', 'SKILL.md'));
    const rolled = await installPack(
      {
        source: await enginePack({ assets: true }),
        dshHome: await home(),
        yes: true,
        interactive: false,
      },
      mine.runtime,
    );

    expect(kept.metadata.status).toBe('installed');
    expect(kept.exitCode).toBe(0);
    const reported = kept.diagnostics.filter((item) => item.code.endsWith('_DOCTOR_PREEXISTING'));
    expect(reported).toHaveLength(2);
    // Reported, not swallowed: the original code and location survive into the report.
    expect(reported.some((item) => item.message.includes('DSH010'))).toBe(true);
    expect(reported.some((item) => item.path?.endsWith('someone-elses.md') === true)).toBe(true);
    // ...and never as an error, which would fail the install through the back door.
    expect(reported.every((item) => item.severity !== 'error')).toBe(true);
    // The install really happened, and at the path the owned-finding case names.
    await expect(
      readFile(join(keptHome, 'skills', 'notes', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('name: notes');

    expect(rolled.metadata.status).toBe('rolled-back');
    expect(rolled.exitCode).toBe(24);
  });

  it('rejects a missing immutable patch payload during apply', async () => {
    const fake = fakeRuntime();
    const read = fake.runtime.readValidatedPack;
    fake.runtime.readValidatedPack = async (root) => {
      const value = await read(root);
      return value.material === undefined
        ? value
        : {
            ...value,
            material: {
              ...value.material,
              files: value.material.files.filter(({ path }) => path !== 'patch/cordis.patch.yml'),
            },
          };
    };
    const dshHome = await home();
    const result = await installPack(
      { source: await enginePack(), dshHome, yes: true, interactive: false },
      fake.runtime,
    );
    expect(result).toMatchObject({ exitCode: 30, metadata: { status: 'rolled-back' } });
    await expect(
      readFile(join(dshHome, 'profiles', 'engine-pack', 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
