# Local Linux desktop release

Self-contained Linux desktop release built from this checkout, plus the in-app upgrade flow that replaces the packaged updater for this build. This is fork infrastructure for `/home/mano`, not an upstream RPM or an app-module bundle; it lives under `.github/fork/` because it edits no upstream source.

## Why the packaged updater cannot work here

Upstream Desktop updates use electron-builder artifacts through `electron-updater`, which requires a packaged `app-update.yml` feed. The Linux release is a directory build assembled from `apps/desktop/lib`, so it deliberately has no feed, and upstream publishes no Linux artifacts. The `desktop update: this application has no packaged update source` failure that this directory fixes is the packaged updater correctly refusing to guess a feed.

The upgrade source for this build is therefore the checkout's upstream branch:

1. `git fetch origin` and compare `HEAD` with `origin/master` (the fork's master contains its own merge commits, so upstream updates are merged, not fast-forwarded).
2. On a clean checkout with newer upstream commits, merge `origin/master` and run the same build/activate pipeline as the launcher.
3. Quit and reopen the application to run the new release.

## Installed paths

| Path | Purpose |
| --- | --- |
| `~/.local/bin/dsh-desktop` | Launcher: `launch`, `update` (fetch + merge + build + activate), `build` (rebuild current source) |
| `~/.local/share/applications/deepseek-harness-dev.desktop` | KDE entry with **Fetch, pull and build release**, **Build current source**, source and log actions |
| `~/.local/share/deepseek-harness-dev/` | Integration scripts linked from this directory, `electron-user-data/`, and the per-user build notes |
| `~/.local/state/deepseek-harness-dev/` | Build logs and `desktop.log` |
| `~/repo/dsh/apps/desktop/.desktop-build/local-linux/` | `current` symlink, numbered releases, build caches |
| `~/.dsh` | Harness data (sessions, settings, credentials); survives rebuilds |

Release directories are immutable: `activate-linux.mjs` switches `current` only after the runtime smoke tests pass and keeps the newest, previous, and any still-running releases.

## Install or refresh the links

```sh
node /home/mano/repo/dsh/.github/fork/linux-desktop/install.mjs
```

This links the scripts in this directory into the installed paths. A hand-edited installed file fails closed; pass `--force` only after moving that content into this directory.

## Upgrade from the application

Application menu → **Check for Updates…** (`local-upgrade.mjs`):

- Reports **already up to date** with the installed version and commit.
- Reports how many upstream commits are pending and offers **Update and Build**, which merges upstream and runs `dsh-desktop update` in the background; the dialog reports completion or the latest log location. Quit and reopen when it finishes.
- Refuses with an explanation when the checkout has uncommitted changes, because the launcher will not merge into a dirty tree.
- Reports merge conflicts separately; the checkout stays in its conflicted state for manual resolution.

`package-linux.mjs` routes the menu and sidebar update entry points to this flow in the packaged build, and the automatic updater poll reports idle instead of failing when no feed exists. Both patches fail the package step loudly if the upstream bundle no longer matches, so an upstream change is reviewed instead of silently skipped.

## Build from a clean checkout

```sh
cd /home/mano/repo/dsh
git fetch origin --prune
git merge --no-edit origin/master   # updates are merges; see FORK.md "Syncing upstream"
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-desktop exec install-electron
pnpm run build
```

then either `dsh-desktop build` or the KDE **Build current source** action to prepare the runtime, package, smoke-test, and activate. **Fetch, pull and build release** does the fetch/merge/build sequence itself while holding the builder lock; builds can run while the application keeps running.

## Paths are machine-specific

The scripts hardcode `/home/mano/repo/dsh` and the `~/.local` / `~/.local/state` paths above because this is one machine's setup. Reusing them elsewhere means editing those constants rather than adding configuration here.
