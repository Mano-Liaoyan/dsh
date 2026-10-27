import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const repo='/home/mano/repo/dsh';
const build=join(repo,'apps/desktop/.desktop-build/local-linux');
const candidate=join(build,'release-candidate');
const record=JSON.parse(readFileSync(join(candidate,'release.json')));
if(record.mode!=='production') throw new Error('Refusing to activate a non-production build');
const releases=join(build,'releases');
const destination=join(releases,record.version+'-'+record.commit.slice(0,8)+'-'+Date.now());
const previous=existsSync(join(build,'current'))?realpathSync(join(build,'current')):undefined;
mkdirSync(releases,{recursive:true});
renameSync(candidate,destination);
const temporary=join(build,'.current-'+process.pid);
symlinkSync(relative(build,destination),temporary);
renameSync(temporary,join(build,'current'));
const {files,...metadata}=record;
mkdirSync(join(repo,'.git/local-desktop'),{recursive:true});
writeFileSync(join(repo,'.git/local-desktop/release.json'),JSON.stringify({...metadata,directory:destination},null,2)+'\n');
console.log('Activated production release: '+destination);

// Each release is about 1 GiB. Keep the new one, the previous one as a
// fallback, and any release a running process still executes from.
const running=new Set();
for(const pid of readdirSync('/proc')){
  if(!/^\d+$/.test(pid)) continue;
  try{ running.add(readlinkSync(join('/proc',pid,'exe'))); }
  catch{ /* The process exited or belongs to another user; it cannot run a release here. */ }
}
const keep=new Set([destination,previous].filter(Boolean));
for(const name of readdirSync(releases)){
  const path=join(releases,name);
  if(keep.has(path)||!statSync(path).isDirectory()) continue;
  if([...running].some(exe=>exe.startsWith(path+'/'))){ console.log('Kept in-use release: '+path); continue; }
  rmSync(path,{recursive:true,force:true});
  console.log('Removed old release: '+path);
}
