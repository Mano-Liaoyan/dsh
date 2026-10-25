#!/usr/bin/env node
// Fork scope check for Mano-Liaoyan/dsh.
//
// Every path a pull request changes must be fork infrastructure, an
// extension under extensions/, documentation, a listed baseline exemption, or
// byte-identical to upstream at the fork's sync point (the merge base of the
// head and upstream). Anything else edits upstream source and fails the check.
// The same classification routes CI: the results are written to
// $GITHUB_OUTPUT so later jobs run only for the kinds of paths that changed.
//
// Usage: node .github/fork/scope.mjs --base <sha> --head <sha> --upstream <ref>
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string', default: 'HEAD' },
    upstream: { type: 'string' },
  },
})
if (!args.base || !args.upstream) {
  console.error('Usage: scope.mjs --base <sha> --head <sha> --upstream <ref>')
  process.exit(2)
}

const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'scope.json'), 'utf8'))
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
const matchesAny = (path, globs) => globs.some(glob => matchesGlob(path, glob))

/** Maps every tracked path of a commit to its `mode oid` tree entry. */
const treeEntries = (commit) => {
  const entries = new Map()
  for (const line of git('ls-tree', '-r', '--full-tree', commit).split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    const [mode, , oid] = line.slice(0, tab).split(' ')
    entries.set(line.slice(tab + 1), `${mode} ${oid}`)
  }
  return entries
}

const syncPoint = git('merge-base', args.head, args.upstream).trim()
const changed = git('diff', '--name-only', '--no-renames', `${args.base}...${args.head}`).split('\n').filter(Boolean)
const headTree = treeEntries(args.head)
const upstreamTree = treeEntries(syncPoint)
const baseline = new Set(config.baseline)

/** Classifies one changed path; `violation` means it edits upstream source. */
const classify = (path) => {
  if (matchesAny(path, config.fork)) return 'fork'
  if (matchesAny(path, config.extensions)) return 'extension'
  if (matchesAny(path, config.docs.include) && !matchesAny(path, config.docs.exclude)) return 'docs'
  if (baseline.has(path)) return 'baseline'
  if (headTree.get(path) === upstreamTree.get(path)) return 'upstream'
  return 'violation'
}

const groups = { fork: [], extension: [], docs: [], baseline: [], upstream: [], violation: [] }
for (const path of changed) groups[classify(path)].push(path)

// Extensions are standalone bundle packages: extensions/<name>/package.json.
const extensionDirs = [...new Set(groups.extension
  .map(path => path.split('/').slice(0, 2).join('/'))
  .filter(dir => existsSync(join(dir, 'package.json'))))]

// Source checks cover the packages that own baseline files: upstream already
// tested its own code, so the integration risk is the fork's exempted edits.
const sourceChanged = groups.baseline.length > 0 || groups.upstream.length > 0
const ownerOf = (path) => {
  const parts = path.split('/')
  if (parts[0] === 'packages' && parts.length > 3) return parts.slice(0, 3).join('/')
  if (parts[0] === 'apps' && parts.length > 2) return parts.slice(0, 2).join('/')
  return undefined
}
const testDirs = [...new Set(config.baseline.map(ownerOf).filter(Boolean))]
  .filter(dir => existsSync(join(dir, 'tests')))

const report = [
  '## Fork scope',
  '',
  `Upstream sync point: \`${syncPoint.slice(0, 12)}\``,
  '',
  '| Kind | Paths |',
  '| --- | ---: |',
  ...Object.entries(groups).map(([kind, paths]) => `| ${kind} | ${paths.length} |`),
]
if (groups.violation.length > 0) {
  report.push(
    '',
    '### Upstream source edits (not allowed)',
    '',
    'This fork only accepts extensions under `extensions/`, documentation, and fork infrastructure. '
    + 'Move the change into an extension, propose it upstream, or add the path to `baseline` in `.github/fork/scope.json` deliberately.',
    '',
    ...groups.violation.map(path => `- \`${path}\``),
  )
}
const text = report.join('\n')
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `docs=${groups.docs.length > 0}`,
    `extensions=${JSON.stringify(extensionDirs)}`,
    `source=${sourceChanged}`,
    `test_dirs=${testDirs.join(' ')}`,
    '',
  ].join('\n'))
}
for (const path of groups.violation) console.log(`::error file=${path}::Upstream source edit outside the fork scope`)
process.exit(groups.violation.length > 0 ? 1 : 0)
