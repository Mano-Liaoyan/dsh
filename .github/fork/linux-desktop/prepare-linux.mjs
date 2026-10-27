// Local Linux adapter for the upstream unpackaged Electron application.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = '/home/mano/repo/dsh';
const app = join(repo, 'apps/desktop');
const require = createRequire(join(app, 'package.json'));
const { prepareDevelopmentProject } = await import(pathToFileURL(join(app, 'scripts/development-project.ts')));
const { DESKTOP_HOST_PROTOCOL_VERSION } = await import(pathToFileURL(join(app, 'src/host-protocol.ts')));
const { readDesktopRuntime } = await import(pathToFileURL(join(app, 'src/runtime-tree.ts')));
const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
const release = {
  schemaVersion: 1,
  version: manifest.version,
  hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
  nodeVersion: execFileSync(require('electron'), ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim(),
  pnpmVersion: JSON.parse(readFileSync(join(app, 'node_modules/pnpm/package.json'), 'utf8')).version,
};
const projectDir = join(app, '.desktop-build/development/project');
// This helper only creates links and metadata. Its target enum currently omits
// Linux; correct the descriptor before it can be consumed by the application.
prepareDevelopmentProject({
  projectDir,
  cliDir: join(repo, 'apps/cli'),
  hostDir: join(repo, 'apps/desktop-host'),
  dependencyDir: join(repo, 'node_modules/.pnpm/node_modules'),
  release,
  target: 'mac-x64',
});
const descriptorPath = join(projectDir, 'desktop-runtime.json');
const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
descriptor.platform = 'linux';
descriptor.arch = 'x64';
writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n');
const verified = readDesktopRuntime(projectDir);
if (verified.platform !== process.platform || verified.arch !== process.arch) {
  throw new Error('Local desktop runtime does not match this computer');
}
const recordDir = join(repo, '.git/local-desktop');
mkdirSync(recordDir, { recursive: true });
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
writeFileSync(join(recordDir, 'release.json'), JSON.stringify({
  ...release, commit, platform: process.platform, arch: process.arch,
  builtAt: new Date().toISOString(),
}, null, 2) + '\n');
console.log(`Prepared DeepSeek Harness ${release.version} (${commit.slice(0, 8)}) for Linux x64`);
