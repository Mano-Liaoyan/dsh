import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smokeDesktopRuntime } from '/home/mano/repo/dsh/apps/desktop/scripts/smoke-runtime.ts';
const root = '/home/mano/repo/dsh/apps/desktop/.desktop-build/local-linux/release-candidate';
const node = root + '/resources/runtime/primary-runtime/dependencies/node/bin/node';
const runtime = root + '/resources/app/dsh';
const resources = root + '/resources/runtime';
const fixtures = mkdtempSync(join(tmpdir(), 'dsh-linux-payload-'));
const environment = {...process.env, NODE_ENV:'production', NODE_OPTIONS:''};
delete environment.ELECTRON_RUN_AS_NODE;
try {
  for (const name of ['runtime-payload-smoke.mjs','pnpm-smoke.mjs']) {
    let source = readFileSync('/home/mano/repo/dsh/apps/desktop/tests/fixtures/' + name,'utf8');
    if (name === 'pnpm-smoke.mjs') {
      const assertion = "assert.ok(process.versions.electron, 'Run the package-manager smoke with Electron Node mode')";
      if (!source.includes(assertion)) throw new Error('Upstream payload smoke changed; review the Linux Node check');
      source = source.replace(assertion,"assert.ok(process.versions.node, 'Run the Linux backend smoke with its bundled Node runtime')");
      source = source.replace('assert.ok(process.versions.electron)', 'assert.ok(process.versions.node)');
    }
    writeFileSync(join(fixtures,name),source);
  }
  execFileSync(node,['--expose-internals',join(fixtures,'runtime-payload-smoke.mjs'),runtime,resources],{env:environment,stdio:'inherit',timeout:120000});
  await smokeDesktopRuntime(runtime,node,JSON.parse(readFileSync(runtime+'/desktop-runtime.json')),environment,resources);
} finally { rmSync(fixtures,{recursive:true,force:true}); }
