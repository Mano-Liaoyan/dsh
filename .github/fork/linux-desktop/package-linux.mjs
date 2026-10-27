// Assemble a self-contained Linux directory release from the verified build.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, globSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const repo = '/home/mano/repo/dsh';
const app = join(repo, 'apps/desktop');
const build = join(app, '.desktop-build/local-linux');
const candidate = join(build, 'release-candidate');
const hostDeploy = join(build, 'production-host');
const shellDeploy = join(build, 'production-shell');
const require = createRequire(join(app, 'package.json'));
const manifest = JSON.parse(readFileSync(join(app, 'package.json')));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const inside = (path, root) => path === root || path.startsWith(root + '/');

if (!process.argv.includes('--reuse-deploy')) {
  for (const destination of [hostDeploy, shellDeploy]) rmSync(destination, { recursive: true, force: true });
  const npmignore = join(app, '.npmignore');
  const previous = existsSync(npmignore) ? readFileSync(npmignore) : undefined;
  try {
    writeFileSync(npmignore, (previous?.toString() ?? '') + '\n.desktop-build\n');
    for (const [name, destination] of [['dsh-desktop-host', hostDeploy], ['dsh-desktop', shellDeploy]]) {
      execFileSync('pnpm', ['--filter', '@deepseek-ai/' + name, '--prod', 'deploy', '--legacy', destination], {cwd: repo, stdio: 'inherit'});
    }
  } finally {
    if (previous === undefined) unlinkSync(npmignore); else writeFileSync(npmignore, previous);
  }
}

function supported(pkg) {
  return (!pkg.os || pkg.os.includes('linux') || pkg.os.includes('any') || pkg.os.every(x => x.startsWith('!') && x !== '!linux'))
    && (!pkg.cpu || pkg.cpu.includes('x64') || pkg.cpu.includes('any') || pkg.cpu.every(x => x.startsWith('!') && x !== '!x64'));
}
function filtered(source) {
  const name = basename(source);
  return !['.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json', '.git', '.desktop-build'].includes(name)
    && !/\.(?:map|tsbuildinfo)$/.test(name) && !/\.d\.[cm]?ts$/.test(name);
}
function normalizeModules(source, destination) {
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true, filter: filtered });
  const vendor = join(destination, '.local-vendor');
  const walk = directory => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isSymbolicLink()) continue;
      const original = join(source, relative(destination, path));
      if (!existsSync(original)) { unlinkSync(path); continue; }
      const target = realpathSync(original);
      if (inside(target, source)) {
        unlinkSync(path);
        symlinkSync(relative(dirname(path), join(destination, relative(source, target))), path);
        continue;
      }
      const pkg = JSON.parse(readFileSync(join(target, 'package.json')));
      // pnpm's private hoist includes links to unrelated workspace projects.
      // Only the two explicit workspace overrides can be runtime dependencies.
      if (!['@deepseek-ai/cosmokit', '@deepseek-ai/schemastery'].includes(pkg.name)) {
        if (relative(source, original).startsWith('.pnpm/node_modules/') || !supported(pkg)) { unlinkSync(path); continue; }
        throw new Error('Unexpected external runtime link: ' + original);
      }
      const local = join(vendor, basename(target));
      if (!existsSync(local)) cpSync(target, local, {
        recursive: true, dereference: true,
        filter: p => filtered(p) && !relative(target, p).split('/').includes('node_modules'),
      });
      unlinkSync(path);
      symlinkSync(relative(dirname(path), local), path);
    }
  };
  walk(destination);
  // Cordis discovers plugins from the application runtime's top-level modules.
  const hoist = join(destination, '.pnpm/node_modules');
  const expose = directory => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.name.startsWith('@') && entry.isDirectory()) { expose(path); continue; }
      if (!existsSync(path)) continue;
      const out = join(destination, relative(hoist, path));
      if (existsSync(out)) continue;
      mkdirSync(dirname(out), {recursive: true});
      symlinkSync(relative(dirname(out), realpathSync(path)), out);
    }
  };
  expose(hoist);
}

// pnpm legacy deploy omits workspace peers that are normally supplied by the
// repository. Include the required peers from this exact checkout, recursively.
function includeWorkspacePeers(modules) {
  const workspace = new Map(globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'native/system/package.json', 'native/system/packages/*/package.json'], {cwd:repo})
    .map(p => [JSON.parse(readFileSync(join(repo,p))).name, dirname(join(repo,p))]));
  const manifests = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, {withFileTypes:true})) {
      const path = join(directory,entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'package.json') manifests.push(path);
    }
  };
  visit(modules);
  const resolves = (directory, name) => {
    for (let cursor = directory; inside(cursor, modules); cursor = dirname(cursor)) {
      if (existsSync(join(cursor, 'node_modules', name, 'package.json'))) return true;
    }
    return existsSync(join(modules,name,'package.json'));
  };
  for (let i=0; i<manifests.length; i++) {
    const path = manifests[i];
    const pkg = JSON.parse(readFileSync(path));
    const dependencies = {...pkg.peerDependencies,...pkg.dependencies};
    for (const name of Object.keys(dependencies)) {
      if (!workspace.has(name) || resolves(dirname(path),name)) continue;
      if (!pkg.dependencies?.[name] && pkg.peerDependenciesMeta?.[name]?.optional) continue;
      const source = workspace.get(name);
      const metadata = JSON.parse(readFileSync(join(source,'package.json')));
      if (!supported(metadata)) continue;
      const out = join(modules,name);
      cpSync(source,out,{recursive:true,dereference:true,filter:p=>filtered(p) && !relative(source,p).split('/').some(part=>['node_modules','tests','.agents'].includes(part))});
      manifests.push(join(out,'package.json'));
      console.log('Included required workspace peer: ' + name);
    }
  }
}

rmSync(candidate, {recursive: true, force: true});
cpSync(dirname(require('electron')), candidate, {recursive: true, verbatimSymlinks: true});
renameSync(join(candidate, 'electron'), join(candidate, 'deepseek-harness'));
rmSync(join(candidate, 'resources/default_app.asar'), {force: true});
const appOut = join(candidate, 'resources/app');
mkdirSync(appOut, {recursive: true});
for (const name of ['lib', 'renderer']) cpSync(join(app, name), join(appOut, name), {recursive: true, filter: filtered});
// The source-built release has no electron-updater feed; its upgrade source is the
// checkout's upstream branch. This module carries that flow into the app menu.
copyFileSync(join(import.meta.dirname, 'local-upgrade.mjs'), join(appOut, 'lib/local-upgrade.js'));
function replaceOnce(code, needle, replacement, adaptation) {
  const parts = code.split(needle);
  if (parts.length !== 2) throw new Error('Upstream desktop bundle changed; review the Linux ' + adaptation + ' adaptation');
  return parts[0] + replacement + parts[1];
}
// Electron's Linux GLib symbols conflict with sharp/libvips. Keep Electron for
// the UI and run the backend using the already bundled, matching Node runtime.
const mainPath = join(appOut, 'lib/main.js');
let mainCode = readFileSync(mainPath, 'utf8');
const hostSelection = /function runtimeResources\(\) \{([\s\S]*?)node: process\.execPath,/;
if (!hostSelection.test(mainCode)) throw new Error('Upstream runtimeResources changed; review the Linux backend adaptation');
mainCode = mainCode.replace(hostSelection, 'function runtimeResources() {$1node: join(process.resourcesPath, "runtime", "primary-runtime", "dependencies", "node", "bin", "node"),');
// Upstream hides the window on close and relies on a tray to bring it back,
// which exists only on Windows. On Linux the app would keep running invisibly,
// so closing the window quits through the normal task-confirmation path.
const closeHide = 'if (backgroundNotice === void 0) hide();';
if (mainCode.split(closeHide).length !== 2) throw new Error('Upstream window close handler changed; review the Linux close adaptation');
mainCode = mainCode.replace(closeHide, 'if (process.platform === "linux") app.quit();\n\t\t\telse ' + closeHide);
// A source-built release has no app-update.yml, so the packaged updater cannot
// work. Route both manual entry points (application menu and sidebar indicator)
// to the source-upgrade flow instead of the updater failure dialog.
mainCode = replaceOnce(mainCode,
  '\tconst openUpdatePrompt = (manual = false) => {\n\t\tif (authenticationOperation !== void 0) {',
  '\tconst openUpdatePrompt = (manual = false) => {\n'
    + '\t\tif (!existsSync(join(process.resourcesPath, "app-update.yml"))) return import("./local-upgrade.js").then(({ showLocalUpgrade }) => showLocalUpgrade(currentDesktopLocale().messages)).catch((error) => {\n'
    + '\t\t\tconsole.error(error);\n'
    + '\t\t});\n'
    + '\t\tif (authenticationOperation !== void 0) {',
  'update entry');
// Automatic checks must not publish a failure for a build that has no feed.
mainCode = replaceOnce(mainCode,
  '\t\t\tif (!this.enabled()) throw new Error("desktop update: this application has no packaged update source");',
  '\t\t\tif (!this.enabled()) return this.setState({ phase: "idle" });',
  'update source');
writeFileSync(mainPath, mainCode);
json(join(appOut, 'package.json'), {
  name: 'deepseek-harness-local', productName: 'DeepSeek Harness', version: manifest.version,
  description: manifest.description, license: manifest.license, type: 'module', main: 'lib/main.js',
  // Wayland app_id, so KDE matches windows to the launcher entry and its icon.
  desktopName: 'deepseek-harness-dev.desktop',
  dshDesktopAppId: 'local.deepseek.harness', dshDesktopUpdateChannel: 'nightly',
});
normalizeModules(join(shellDeploy, 'node_modules'), join(appOut, 'node_modules'));
includeWorkspacePeers(join(appOut, 'node_modules'));
const runtime = join(appOut, 'dsh');
mkdirSync(runtime, {recursive: true});
normalizeModules(join(hostDeploy, 'node_modules'), join(runtime, 'node_modules'));
const host = join(runtime, 'node_modules/@deepseek-ai/dsh-desktop-host');
mkdirSync(host, {recursive: true});
cpSync(join(hostDeploy, 'lib'), join(host, 'lib'), {recursive: true, filter: filtered});
cpSync(join(hostDeploy, 'package.json'), join(host, 'package.json'));
includeWorkspacePeers(join(runtime, 'node_modules'));
json(join(runtime, 'package.json'), {name: '@deepseek-ai/dsh-desktop-runtime', private: true, version: manifest.version, type: 'module'});
const resourceRuntime = join(candidate, 'resources/runtime');
cpSync(join(build, 'runtime'), resourceRuntime, {recursive: true, verbatimSymlinks: true});
// The CLI's directory-layout fallback looks beside dsh/ for its support runtime.
symlinkSync('../runtime', join(appOut,'runtime'));
cpSync(join(app, 'scripts/node-bin'), join(resourceRuntime, 'bin'), {recursive: true});
cpSync(join(app, 'resources/icon.png'), join(candidate, 'resources/icon.png'));
const protocolSource = readFileSync(join(app, 'src/host-protocol.ts'), 'utf8');
const protocol = Number(protocolSource.match(/DESKTOP_HOST_PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1]);
if (!protocol) throw new Error('Unable to read desktop Host protocol version');
const release = {
  schemaVersion: 1, version: manifest.version, hostProtocolVersion: protocol,
  nodeVersion: execFileSync(join(candidate, 'deepseek-harness'), ['-p', 'process.versions.node'], {encoding:'utf8', env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}).trim(),
  pnpmVersion: JSON.parse(readFileSync(join(resourceRuntime, 'primary-runtime/runtime.json'))).pnpm,
};
json(join(resourceRuntime,'versions.json'), {schemaVersion:1,node:release.nodeVersion,pnpm:release.pnpmVersion});
const sharedPackages = [];
for (const scope of readdirSync(join(runtime, 'node_modules'))) {
  if (scope.startsWith('.')) continue;
  const names = scope.startsWith('@') ? readdirSync(join(runtime, 'node_modules', scope)).map(n => scope + '/' + n) : [scope];
  for (const name of names) {
    const p = join(runtime, 'node_modules', name, 'package.json');
    if (!existsSync(p)) continue;
    const pkg = JSON.parse(readFileSync(p));
    if (typeof pkg.version === 'string') sharedPackages.push({name: pkg.name, version: pkg.version, path: 'node_modules/' + name});
  }
}
json(join(runtime, 'desktop-runtime.json'), {schemaVersion:1, release, platform:'linux', arch:'x64', sharedPackages, files:[]});

// Reject packages that still depend on a checkout path; record payload checksums.
const inventory = [];
function inspect(directory) {
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else if (entry.isSymbolicLink()) {
      if (!existsSync(path) || !inside(realpathSync(path), candidate)) throw new Error('Release contains an external or broken link: ' + path);
    } else if (entry.isFile()) inventory.push({path:relative(candidate,path),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
  }
}
inspect(candidate);
json(join(candidate, 'release.json'), {
  ...release, mode:'production', platform:'linux', arch:'x64',
  commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
  builtAt:new Date().toISOString(),
  // The in-app upgrade flow reads these to find its update source and builder.
  source: repo, launcher: '/home/mano/.local/bin/dsh-desktop', files:inventory,
});
console.log('Production release candidate: ' + candidate);
console.log('Verified ' + inventory.length + ' files; all symbolic links stay inside the release.');
