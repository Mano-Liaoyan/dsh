/**
 * In-app version upgrade for the locally built Linux release.
 *
 * This release is assembled from the source checkout, so it carries no
 * electron-updater feed and cannot download an installer. Its update source is
 * the checkout's upstream branch: check upstream commits, then run the same
 * fetch/merge/build pipeline as the "Fetch, pull and build release" launcher
 * action. The module is copied into the packaged application by
 * package-linux.mjs, so it must stay plain JavaScript without build steps.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const DEFAULT_SOURCE = '/home/mano/repo/dsh';
const DEFAULT_LAUNCHER = '/home/mano/.local/bin/dsh-desktop';
const STATE_DIRECTORY = '/home/mano/.local/state/deepseek-harness-dev';
const GIT_ENVIRONMENT = Object.freeze({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  // A packaged application has no terminal to answer a credential prompt.
  GIT_ASKPASS: '/bin/true',
});

const zh = {
  title: '版本升级',
  current: '已是最新版本',
  checkFailed: '无法检查更新',
  dirty: '发现上游更新，但源码有未提交的更改',
  dirtyDetail: (behind, paths) => `上游有 ${behind} 个新提交需要合并。请先提交或暂存以下更改后重试：\n\n${paths}`,
  available: (target) => `发现新版本：${target}`,
  availableDetail: (behind, ahead, current) => `上游有 ${behind} 个新提交，将合并到本地源码并重新构建桌面应用（约几分钟）。构建期间可以继续使用当前版本，完成后需要退出并重新打开应用。`
    + (ahead > 0 ? `\n\n本地独有的 ${ahead} 个提交会被合并保留。` : '')
    + `\n\n当前版本：${current}`,
  update: '更新并构建',
  cancel: '取消',
  building: '正在后台构建更新',
  buildingDetail: '正在拉取并构建新版本，完成后会再次提示。构建期间可以继续使用当前版本。',
  built: '更新已构建完成',
  builtDetail: '请退出并重新打开 DeepSeek Harness 以使用新版本。',
  buildFailed: '构建更新失败',
  buildFailedDetail: (launcher) => `构建没有成功完成。请查看最新日志：${STATE_DIRECTORY}\n或在终端运行：${launcher} build`,
  conflict: '合并上游代码时发生冲突',
  conflictDetail: (source) => `自动合并上游代码时发生冲突，源码保持冲突状态。请在终端执行 git status 解决冲突，然后再次更新。\n\n源码：${source}`,
  currentDetail: (current, upstreamRef) => `当前版本：${current}\n上游分支：${upstreamRef}\n上游没有新的提交。`,
};

const en = {
  title: 'Version Upgrade',
  current: 'Already up to date',
  checkFailed: 'Could not check for updates',
  dirty: 'Upstream updates found, but the source has uncommitted changes',
  dirtyDetail: (behind, paths) => `Upstream has ${behind} new commit(s) to merge. Commit or stash these changes first:\n\n${paths}`,
  available: (target) => `Update available: ${target}`,
  availableDetail: (behind, ahead, current) => `Upstream has ${behind} new commit(s). Updating merges the source and rebuilds the desktop application (a few minutes). You can keep using the current version during the build; quit and reopen the app when it finishes.`
    + (ahead > 0 ? `\n\n${ahead} local commit(s) are kept by the merge.` : '')
    + `\n\nCurrent: ${current}`,
  update: 'Update and Build',
  cancel: 'Cancel',
  building: 'Building the update in the background',
  buildingDetail: 'Fetching and building the new version. You can keep using the current version; you will be prompted when the build finishes.',
  built: 'The update finished building',
  builtDetail: 'Quit and reopen DeepSeek Harness to use the new version.',
  buildFailed: 'Building the update failed',
  buildFailedDetail: (launcher) => `The build did not complete. See the latest log in ${STATE_DIRECTORY}\nor run: ${launcher} build`,
  conflict: 'Merging the upstream source stopped on a conflict',
  conflictDetail: (source) => `The automatic merge stopped on a conflict, so the checkout is still in a conflicted state. Resolve it with git status in a terminal, then update again.\n\nSource: ${source}`,
  currentDetail: (current, upstreamRef) => `Current: ${current}\nUpstream branch: ${upstreamRef}\nNo newer upstream commits.`,
};

/**
 * Read the release metadata written beside the packaged resources.
 * @returns {{version?: string, commit?: string, source?: string, launcher?: string}} Recorded release facts, or an empty object.
 */
export function readReleaseMetadata() {
  if (typeof process.resourcesPath !== 'string') return {};
  try {
    return JSON.parse(readFileSync(join(dirname(process.resourcesPath), 'release.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function git(source, args) {
  const { stdout } = await exec('git', ['-C', source, ...args], {
    env: GIT_ENVIRONMENT,
    timeout: 300_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Compare the installed source release with the upstream branch it is built from.
 * @param {string} source - Source checkout the running release was built from.
 * @returns {Promise<{upstreamRef: string, behind: number, ahead: number, dirtyPaths: string[], version?: string}>} Upstream distance, local changes, and the upstream release version when an update exists.
 */
export async function inspectSourceUpdate(source = DEFAULT_SOURCE) {
  // Local merges mean the checkout is usually ahead of upstream, so a fast-forward-only pull is not enough.
  await git(source, ['fetch', 'origin', '--prune']);
  const upstreamRef = ((await git(source, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim() || 'refs/remotes/origin/master')
    .replace(/^refs\/remotes\//u, '');
  const behind = Number((await git(source, ['rev-list', '--count', `HEAD..${upstreamRef}`])).trim());
  const ahead = Number((await git(source, ['rev-list', '--count', `${upstreamRef}..HEAD`])).trim());
  const dirtyPaths = (await git(source, ['status', '--porcelain'])).split('\n').filter(Boolean);
  let version;
  if (behind > 0) {
    try {
      version = JSON.parse(await git(source, ['show', `${upstreamRef}:apps/desktop/package.json`])).version;
    } catch {
      version = undefined;
    }
  }
  return { upstreamRef, behind, ahead, dirtyPaths, version };
}

function message(error) {
  const detail = typeof error === 'object' && error !== null && typeof error.stderr === 'string' && error.stderr.trim() !== ''
    ? error.stderr.trim()
    : error instanceof Error ? error.message : String(error);
  return detail.length > 1500 ? `${detail.slice(0, 1500)}…` : detail;
}

function mergeInProgress(source) {
  return existsSync(join(source, '.git', 'MERGE_HEAD'));
}

/**
 * Open the upgrade dialog: check upstream commits, then run the launcher's update/build pipeline.
 * @param {object} messages - Desktop shell message dictionary used only to detect the UI language.
 * @returns {Promise<void>} Resolves after the dialog interaction settles.
 */
export async function showLocalUpgrade(messages) {
  const electron = await import('electron');
  const { app, BrowserWindow, dialog } = electron;
  const release = readReleaseMetadata();
  const source = release.source ?? DEFAULT_SOURCE;
  const launcher = release.launcher ?? DEFAULT_LAUNCHER;
  const text = typeof messages?.checkUpdatesMenu === 'string' && messages.checkUpdatesMenu.includes('更新') ? zh : en;
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const show = (options) => parent === undefined || parent.isDestroyed()
    ? dialog.showMessageBox(options)
    : dialog.showMessageBox(parent, options);
  const current = `${release.version ?? app.getVersion()} (${(release.commit ?? '').slice(0, 8) || 'unknown'})`;

  let update;
  try {
    update = await inspectSourceUpdate(source);
  } catch (error) {
    await show({
      type: 'error',
      title: text.title,
      message: text.checkFailed,
      detail: `git fetch origin (${source})\n\n${message(error)}`,
      noLink: true,
    });
    return;
  }

  if (update.behind === 0) {
    await show({
      type: 'info',
      title: text.title,
      message: text.current,
      detail: text.currentDetail(current, update.upstreamRef),
      noLink: true,
    });
    return;
  }

  if (update.dirtyPaths.length > 0) {
    const paths = update.dirtyPaths.slice(0, 10).join('\n');
    const more = update.dirtyPaths.length > 10 ? `\n… ${update.dirtyPaths.length - 10} more` : '';
    await show({
      type: 'warning',
      title: text.title,
      message: text.dirty,
      detail: text.dirtyDetail(update.behind, `${paths}${more}`),
      noLink: true,
    });
    return;
  }

  const target = update.version === undefined ? `${update.behind}` : update.version;
  const confirmation = await show({
    type: 'info',
    title: text.title,
    message: text.available(target),
    detail: text.availableDetail(update.behind, update.ahead, current),
    buttons: [text.update, text.cancel],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (confirmation.response !== 0) return;

  const started = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(launcher, ['update'], { stdio: 'ignore' });
    } catch (error) {
      resolve({ error });
      return;
    }
    child.once('error', (error) => resolve({ error }));
    resolve({ child });
  });
  if (started.error !== undefined) {
    await show({
      type: 'error',
      title: text.title,
      message: text.buildFailed,
      detail: `${launcher} update\n\n${message(started.error)}`,
      noLink: true,
    });
    return;
  }

  // Track the exit before the modal notice so a build that stops immediately cannot be missed.
  const exitCode = new Promise((resolve) => {
    started.child.once('exit', (code) => resolve(code ?? 1));
    started.child.once('error', () => resolve(1));
  });

  await show({
    type: 'info',
    title: text.title,
    message: text.building,
    detail: text.buildingDetail,
    noLink: true,
  });

  const code = await exitCode;
  if (code === 0) {
    await show({
      type: 'info',
      title: text.title,
      message: text.built,
      detail: text.builtDetail,
      noLink: true,
    });
    return;
  }
  const conflict = mergeInProgress(source);
  await show({
    type: 'error',
    title: text.title,
    message: conflict ? text.conflict : text.buildFailed,
    detail: conflict ? text.conflictDetail(source) : text.buildFailedDetail(launcher),
    noLink: true,
  });
}
