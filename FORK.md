# Mano-Liaoyan/dsh fork

This repository is a personal fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). It stays easy to sync by never editing upstream source: fork work goes into extensions and documentation only.

## What a pull request may change

The **Fork CI / scope** check classifies every changed path and fails on anything outside these kinds:

| Kind | Paths |
| --- | --- |
| Extensions | `extensions/<name>/`, each a standalone DSH bundle package |
| Documentation | Markdown and `*.i18n.yaml` files, `docs/`, `.agents/skills/`, `.agents/notes/`; test expectations such as `*.expected.md` do not count |
| Fork infrastructure | `.github/fork/`, `.github/workflows/fork-*.yml`, this file |
| Upstream sync | Any path whose content equals upstream at the merge base of the pull request head and upstream `master` |
| Baseline exemptions | The paths listed under `baseline` in [.github/fork/scope.json](.github/fork/scope.json) |

The baseline holds the provider sign-in change made before this policy existed. Adding a path to it is a deliberate decision to carry an upstream source edit, and every such path can conflict when syncing.

## Extensions

Each `extensions/<name>/` directory is one standalone DSH bundle package: a `package.json` with `name`, `version`, a `dsh.bundle` declaration, and peer dependencies on the `@deepseek-ai/dsh-*` packages it uses, plus `src/` and `tests/`. Extensions are not pnpm workspace members, so adding one never edits upstream `pnpm-workspace.yaml` or `pnpm-lock.yaml`. Declare `typecheck`, `test`, and `build` scripts as needed; Fork CI runs each one that exists. An extension `README.md` falls under the upstream bilingual documentation rule, so it needs a `README.zh.md` counterpart and a recorded pair (`pnpm run verify-translation-pairing --write <pair>`).

DSH installs a bundle from Git with a subdirectory path, for example `git+https://github.com/Mano-Liaoyan/dsh.git#<commit>&path:/extensions/<name>`. To list fork extensions on the Plugins page, publish a plugin index as described in [docs/user/guide/plugin-market.md](docs/user/guide/plugin-market.md).

## CI

Upstream workflows need deepseek-ai's enterprise runners and release credentials, so [fork-upstream-workflows.yml](.github/workflows/fork-upstream-workflows.yml) disables every workflow except `fork-*.yml` after each push to `master`. [fork-ci.yml](.github/workflows/fork-ci.yml) runs for pull requests:

| Job | Runs when | Does |
| --- | --- | --- |
| `scope` | always | Enforces the table above and routes the jobs below |
| `docs` | documentation changed | `pnpm run test:docs` |
| `extension <dir>` | that extension changed | Installs the extension on its own, then runs its `typecheck`, `test`, and `build` scripts when present |
| `source` | a baseline path or synced upstream source changed | `pnpm run typecheck`, then Vitest for the packages owning baseline paths |
| `gate` | always | Passes when every job above passed or was skipped |

`scope` and `gate` are the required checks on `master`.

## Syncing upstream

Use **Sync fork** on GitHub, or merge `upstream/master` locally and open a pull request. Synced files match upstream, so the scope check accepts them; conflicts can only occur in baseline paths.
