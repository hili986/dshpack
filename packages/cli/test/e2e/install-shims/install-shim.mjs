import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const integrity = `sha512-${createHash('sha512').update('e2e registry tarball').digest('base64')}`;

function lockYaml(specifier) {
  return [
    "lockfileVersion: '9.0'",
    'importers:',
    '  .:',
    '    dependencies:',
    '      example-bundle:',
    `        specifier: ${specifier}`,
    '        version: 1.0.0',
    'packages:',
    '  example-bundle@1.0.0:',
    '    resolution:',
    `      integrity: ${integrity}`,
    '',
  ].join('\n');
}

const [tool, ...argv] = process.argv.slice(2);
const dshHome = process.env.DSH_HOME;
const logPath = process.env.DSHPACK_INSTALL_SHIM_LOG;

if (!dshHome || !logPath || (tool !== 'dsh' && tool !== 'pnpm')) {
  process.stderr.write('install shim environment is incomplete\n');
  process.exitCode = 88;
} else {
  await appendFile(
    logPath,
    `${JSON.stringify({
      tool,
      argv,
      cwd: process.cwd(),
      dshHome,
      ignoreScripts: process.env.npm_config_ignore_scripts,
    })}\n`,
  );

  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(tool === 'dsh' ? '0.1.0-rc.6\n' : '11.7.0\n');
  } else if (tool === 'pnpm' && argv[0] === 'add') {
    await writeFile(join(process.cwd(), 'pnpm-lock.yaml'), lockYaml('^1.0.0'));
    process.stdout.write('resolved\n');
  } else if (tool === 'pnpm' && argv[0] === 'rebuild') {
    process.stdout.write('rebuilt\n');
  } else if (tool === 'dsh') {
    const profileIndex = argv.indexOf('--profile');
    const profile = profileIndex < 0 ? undefined : argv[profileIndex + 1];
    const profileRoot = profile === undefined ? undefined : join(dshHome, 'profiles', profile);
    if (
      argv[0] === 'plugin' &&
      profile !== undefined &&
      argv.includes('list') &&
      argv.includes('--depth=0') &&
      profileRoot !== undefined
    ) {
      await mkdir(profileRoot, { recursive: true });
      await writeFile(
        join(profileRoot, 'package.json'),
        `${JSON.stringify({
          name: `dsh-profile-${profile}`,
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
        })}\n`,
      );
      await writeFile(
        join(profileRoot, 'cordis.patch.yml'),
        '# Your patch layer for this dsh profile, applied after every bundle layer:\n' +
          '# a top-level YAML array of loader patch entries.\n[]\n',
      );
      await writeFile(
        join(profileRoot, 'pnpm-workspace.yaml'),
        'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
      );
      process.stdout.write('initialized\n');
    } else if (
      argv[0] === 'plugin' &&
      profileRoot !== undefined &&
      argv.includes('add') &&
      argv.includes('example-bundle@1.0.0')
    ) {
      const profilePackagePath = join(profileRoot, 'package.json');
      const profilePackage = JSON.parse(await readFile(profilePackagePath, 'utf8'));
      profilePackage.dependencies['example-bundle'] = '1.0.0';
      profilePackage.dsh.profile.bundles.push('example-bundle');
      await writeFile(profilePackagePath, `${JSON.stringify(profilePackage)}\n`);
      const bundle = join(profileRoot, 'node_modules', 'example-bundle');
      await mkdir(join(bundle, 'lib'), { recursive: true });
      await writeFile(
        join(bundle, 'package.json'),
        `${JSON.stringify({
          name: 'example-bundle',
          version: '1.0.0',
          dsh: { bundle: { patch: 'lib/index.yml' } },
        })}\n`,
      );
      await writeFile(join(bundle, 'lib', 'index.yml'), '[]\n');
      await writeFile(join(profileRoot, 'pnpm-lock.yaml'), lockYaml('1.0.0'));
      process.stdout.write('added\n');
    } else if (
      profileRoot !== undefined &&
      (argv.includes('--dump-config') || argv.includes('--dump-default-config'))
    ) {
      await writeFile(join(profileRoot, 'cordis.yml'), '[]\n');
      process.stdout.write('[]\n');
    } else {
      process.stderr.write(`unexpected dsh argv: ${JSON.stringify(argv)}\n`);
      process.exitCode = 89;
    }
  } else {
    process.stderr.write(`unexpected pnpm argv: ${JSON.stringify(argv)}\n`);
    process.exitCode = 89;
  }
}
