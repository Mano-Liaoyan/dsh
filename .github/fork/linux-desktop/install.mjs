/**
 * Link the local Linux release tooling in this directory into the per-user
 * locations the launcher and desktop entry use. Run after a checkout update:
 *
 *   node .github/fork/linux-desktop/install.mjs [--force]
 *
 * Existing regular files are replaced only when their bytes already match this
 * directory, so hand edits fail closed and report the conflicting path.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceDirectory = import.meta.dirname
const integrationDirectory = '/home/mano/.local/share/deepseek-harness-dev'
const launcherPath = '/home/mano/.local/bin/dsh-desktop'
const desktopEntryPath = '/home/mano/.local/share/applications/deepseek-harness-dev.desktop'
const force = process.argv.includes('--force')

const links = [
  ...[
    'package-linux.mjs',
    'local-upgrade.mjs',
    'activate-linux.mjs',
    'smoke-linux.mjs',
    'prepare-linux.mjs',
  ].map((name) => [join(sourceDirectory, name), join(integrationDirectory, name), name]),
  [join(sourceDirectory, 'GUIDE.md'), join(integrationDirectory, 'README.md'), 'README.md'],
  [join(sourceDirectory, 'dsh-desktop'), launcherPath, 'dsh-desktop'],
  [join(sourceDirectory, 'deepseek-harness-dev.desktop'), desktopEntryPath, 'deepseek-harness-dev.desktop'],
]

/** @type {string[]} */
const problems = []
/** @type {string[]} */
const actions = []

for (const [source, destination, name] of links) {
  mkdirSync(dirname(destination), { recursive: true })
  const current = existsSync(destination) ? lstatSync(destination) : undefined
  if (current?.isSymbolicLink()) {
    const target = readlinkSync(destination)
    if (target === source) {
      actions.push(`current ${name}`)
      continue
    }
    rmSync(destination)
    symlinkSync(source, destination)
    actions.push(`relinked ${name}`)
    continue
  }
  if (current === undefined) {
    symlinkSync(source, destination)
    actions.push(`linked ${name}`)
    continue
  }
  const identical = current.isFile() && readFileSync(destination).equals(readFileSync(source))
  if (!identical && !force) {
    problems.push(`${name}: ${destination} differs from ${source}; rerun with --force to replace it`)
    continue
  }
  rmSync(destination)
  symlinkSync(source, destination)
  actions.push(`${force ? 'replaced' : 'converted'} ${name}`)
}

// The launcher must stay executable after a checkout that drops the mode bit.
chmodSync(join(sourceDirectory, 'dsh-desktop'), 0o755)

for (const action of actions) console.log(action)
for (const problem of problems) console.error(problem)
console.log(`${links.length - problems.length}/${links.length} local release paths link to ${sourceDirectory}`)
process.exit(problems.length === 0 ? 0 : 1)
