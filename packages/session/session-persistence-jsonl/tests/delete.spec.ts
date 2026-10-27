import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionDeletionConflictError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generationLogFilename, sessionDir } from '../src/format.ts'
import { SessionWriteLease } from '../src/lease.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const removal = vi.hoisted(() => ({
  before: undefined as ((path: string) => void | Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    unlink: async (path: string) => {
      await removal.before?.(path)
      return actual.unlink(path)
    },
  }
})

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  removal.before = undefined
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(compression: 'none' | 'zstd' = 'none') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delete-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  const id = SessionId('delete-me')
  const header = meta(id)
  const dir = sessionDir(root, header.cwd, id)
  return { root, ctx, storage: ctx.sessionPersistence, id, header, dir, compression }
}

async function materialized(compression: 'none' | 'zstd' = 'none') {
  const fixture = await setup(compression)
  const writer = await fixture.storage.create(fixture.header)
  await writer.flush()
  await writer.close()
  return fixture
}

describe('inactive Session deletion', () => {
  it.each(['none', 'zstd'] as const)('removes all %s generations and known stages, retaining unrelated files and the lock inode', async (compression) => {
    const { storage, id, dir } = await materialized(compression)
    const older = generationLogFilename(0, compression)
    await writeFile(join(dir, older), 'historical bytes')
    await writeFile(join(dir, `session.migration.0123456789abcdef.jsonl${compression === 'zstd' ? '.zstd' : ''}.tmp`), 'stage')
    await writeFile(join(dir, `${generationLogFilename(SESSION_FORMAT_VERSION, compression)}.012345abcdef.tmp`), 'stage')
    await writeFile(join(dir, 'notes.txt'), 'keep')
    const before = process.platform === 'win32' ? undefined : await stat(join(dir, 'session.lock'), { bigint: true })
    expect(await storage.delete(id)).toBe(true)
    expect(await storage.stat(id)).toBeUndefined()
    expect(await storage.list()).toEqual([])
    expect(await storage.delete(id)).toBe(false)
    await expect(storage.open(id, 'write')).rejects.toBeInstanceOf(SessionPersistenceNotFoundError)
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('keep')
    expect((await readdir(dir)).sort()).toEqual(process.platform === 'win32' ? ['notes.txt'] : ['notes.txt', 'session.lock'])
    if (before !== undefined) expect((await stat(join(dir, 'session.lock'), { bigint: true })).ino).toBe(before.ino)
    const recreated = await storage.create(meta(id))
    await recreated.flush()
    expect((await recreated.read()).events).toEqual([])
    await recreated.close()
  })

  // Windows symlink creation requires privileges not provided by the unit lane.
  it.skipIf(process.platform === 'win32')('refuses a symlinked Session directory without touching its target', async () => {
    const { storage, id, dir, root } = await materialized()
    const target = join(root, 'owned-target')
    await rename(dir, target)
    await symlink(target, dir, 'dir')
    const before = await readdir(target)
    await expect(storage.delete(id)).rejects.toThrow('not a regular Session directory')
    expect(await readdir(target)).toEqual(before)
  })

  it('returns absent without creating a storage root', async () => {
    const { storage, id, root } = await setup()
    expect(await storage.delete(id)).toBe(false)
    expect(await readdir(root)).toEqual([])
  })

  it('refuses pending and materialized writers without closing them', async () => {
    const { storage, id, header } = await setup()
    const writer = await storage.create(header)
    await expect(storage.delete(id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.flush()
    await expect(storage.delete(id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    expect(await storage.stat(id)).toBeDefined()
    await writer.close()
    expect(await storage.delete(id)).toBe(true)
  })

  it('takes the cross-instance kernel lease and releases a refused local claim', async () => {
    const { storage, id, root } = await materialized()
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const writer = await other.sessionPersistence.open(id, 'write')
    await expect(storage.delete(id)).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    await writer.close()
    expect(await storage.delete(id)).toBe(true)
  })

  it('rejects pre-aborted deletion without taking ownership', async () => {
    const { storage, id } = await materialized()
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(storage.delete(id, { signal: controller.signal })).rejects.toThrow('already cancelled')
    const writer = await storage.open(id, 'write')
    await writer.close()
  })

  it('cancels before mutation and releases both exclusions', async () => {
    const { storage, id } = await materialized()
    const controller = new AbortController()
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args)
      controller.abort(new Error('cancel deletion'))
      return lease
    })
    await expect(storage.delete(id, { signal: controller.signal })).rejects.toThrow('cancel deletion')
    expect(await storage.stat(id)).toBeDefined()
    const writer = await storage.open(id, 'write')
    await writer.close()
    expect(await storage.delete(id)).toBe(true)
  })

  it('excludes concurrent write-open and ignores cancellation after mutation begins', async () => {
    const { storage, id } = await materialized()
    const controller = new AbortController()
    let enter!: () => void
    let resume!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const resumed = new Promise<void>((resolve) => { resume = resolve })
    removal.before = async () => { enter(); await resumed }
    const deleting = storage.delete(id, { signal: controller.signal })
    try {
      await entered
      await expect(storage.open(id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      controller.abort()
    } finally {
      resume()
    }
    expect(await deleting).toBe(true)
  })

  it('retains the authoritative generation after predecessor removal fails', async () => {
    const { storage, id, dir } = await materialized()
    const highest = join(dir, generationLogFilename(SESSION_FORMAT_VERSION, 'none'))
    const bytes = await readFile(highest)
    await writeFile(join(dir, generationLogFilename(0, 'none')), 'older')
    await writeFile(join(dir, generationLogFilename(1, 'none')), 'older')
    removal.before = (path) => { if (path.endsWith('session.v1.jsonl')) throw new Error('unlink failed') }
    await expect(storage.delete(id)).rejects.toThrow('unlink failed')
    expect(await readFile(highest)).toEqual(bytes)
    expect(await readdir(dir)).not.toContain('session.jsonl')
    expect(await storage.stat(id)).toBeDefined()
    removal.before = undefined
    expect(await storage.delete(id)).toBe(true)
  })

  it('checks conditional revisions under the lease before removing files', async () => {
    const { storage, id, dir } = await materialized()
    const snapshot = await storage.stat(id)
    if (snapshot === undefined) throw new Error('materialized session snapshot missing')
    const current = join(dir, generationLogFilename(SESSION_FORMAT_VERSION, 'none'))
    const bytes = await readFile(current)
    await writeFile(current, Buffer.concat([bytes, Buffer.from('changed')]))
    await expect(storage.delete(id, { ifRevision: snapshot.revision })).rejects.toBeInstanceOf(SessionDeletionConflictError)
    expect(await readFile(current)).toEqual(Buffer.concat([bytes, Buffer.from('changed')]))
    const fresh = await storage.stat(id)
    if (fresh === undefined) throw new Error('updated session snapshot missing')
    expect(await storage.delete(id, { ifRevision: fresh.revision })).toBe(true)
  })

  it('notifies only committed deletion and contains observer and logger failures', async () => {
    const { ctx, storage, id } = await materialized()
    const observed: string[] = []
    ctx.on('session-persistence/deleted', (deletedId) => { observed.push(deletedId) })
    const emit = ctx.emit.bind(ctx)
    vi.spyOn(ctx, 'emit').mockImplementation((...args) => {
      const name = typeof args[0] === 'string' ? args[0] : args[1]
      if (name === 'session-persistence/deleted') {
        emit('session-persistence/deleted', id)
        throw new Error('observer failed')
      }
    })
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { throw new Error('logger failed') })
    expect(await storage.delete(id)).toBe(true)
    expect(await storage.delete(id)).toBe(false)
    expect(observed).toEqual([id])
  })

  it('reports completed deletion with a lock-release failure and frees the local claim', async () => {
    const { storage, id } = await materialized()
    const acquire = SessionWriteLease.acquire.bind(SessionWriteLease)
    vi.spyOn(SessionWriteLease, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args)
      const release = lease.release.bind(lease)
      vi.spyOn(lease, 'release').mockImplementationOnce(async () => {
        await release()
        throw new Error('release failed')
      })
      return lease
    })
    await expect(storage.delete(id)).rejects.toThrow('deletion completed and lock release failed')
    expect(await storage.stat(id)).toBeUndefined()
    expect(await storage.delete(id)).toBe(false)
  })
})
