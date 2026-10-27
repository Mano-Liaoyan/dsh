import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionFormatUnsupportedError, SessionDeletionConflictError, SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { harness } from './harness.ts'

const fixtures: Awaited<ReturnType<typeof harness>>[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(item => item.dispose())) })
async function setup() { const test = await harness(); fixtures.push(test); return test }

describe('stored Session deletion policy', () => {
  it('requires confirmation before storage reads and refuses foreign attached Sessions', async () => {
    const { ctx } = await setup()
    const id = SessionId('live')
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    expect(await ctx.sessionDelete.delete({ sessionId: id, confirmed: false })).toEqual({ sessionId: id, code: 'confirmation-required' })
    expect(stat).not.toHaveBeenCalled()
    ctx.sessions.create(id)
    expect(await ctx.sessionDelete.delete({ sessionId: id, confirmed: true })).toEqual({ sessionId: id, code: 'in-use' })
    expect(ctx.sessions.get(id)).toBeDefined()
  })

  it('reports absence without deletion', async () => {
    const { ctx } = await setup()
    expect(await ctx.sessionDelete.delete({ sessionId: SessionId('missing'), confirmed: true })).toMatchObject({ code: 'not-found' })
  })

  it('refuses linked children, fork seeds, and parents with stored children', async () => {
    const test = await setup()
    const parent = await test.stored('parent')
    const child = await test.stored('child', { origin: 'subagent', parentSession: parent })
    for (const id of [parent, child]) {
      expect(await test.ctx.sessionDelete.delete({ sessionId: id, confirmed: true })).toEqual({ sessionId: id, code: 'related-session' })
      expect(await test.ctx.sessionPersistence.stat(id)).toBeDefined()
    }
    const seeded = await test.stored('seeded', { isSeeded: true })
    expect(await test.ctx.sessionDelete.delete({ sessionId: seeded, confirmed: true })).toMatchObject({ code: 'related-session' })
  })

  it('refuses stored reminder rows without deleting them', async () => {
    const test = await setup()
    const sessionId = await test.stored('reminder')
    const reminder = await test.ctx.schedule.create(sessionId, { title: 'Later', prompt: 'Later', after_seconds: 3600 })
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'scheduled' })
    expect(await test.ctx.schedule.catalog()).toMatchObject([{ id: reminder.id, sessionId }])
    expect(await test.ctx.sessionPersistence.stat(sessionId)).toBeDefined()
  })

  it('refuses a writer and revision conflicts with structured in-use results', async () => {
    const test = await setup()
    const sessionId = await test.stored('writer')
    const handle = await test.ctx.sessionPersistence.open(sessionId, 'write')
    try {
      expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'in-use' })
    } finally { await handle.close() }
    vi.spyOn(test.ctx.sessionPersistence, 'delete').mockRejectedValueOnce(new SessionDeletionConflictError(sessionId))
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toMatchObject({ code: 'in-use' })
  })

  it('refuses parent catalogs even when no local child artifact exists', async () => {
    const test = await setup()
    const sessionId = await test.stored('catalog-parent')
    const handle = await test.ctx.sessionPersistence.open(sessionId, 'write')
    await handle.append([{ type: 'subagent/catalog', seq: SessionSeq(2), time: 1,
      data: { version: 0, childId: SessionId('external-child'), childCreatedAt: 1, mode: 'one-shot' } }])
    await handle.close()
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'related-session' })
    expect(await test.ctx.sessionPersistence.stat(sessionId)).toBeDefined()
  })

  it('rechecks an attachment admitted while the preflight was suspended', async () => {
    const test = await setup()
    const sessionId = await test.stored('reattached')
    const remove = vi.spyOn(test.ctx.sessionPersistence, 'delete')
    const list = test.ctx.sessionPersistence.list.bind(test.ctx.sessionPersistence)
    vi.spyOn(test.ctx.sessionPersistence, 'list').mockImplementationOnce(async () => {
      test.ctx.sessions.create(sessionId)
      return list()
    })
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'in-use' })
    expect(remove).not.toHaveBeenCalled()
  })

  it('reports a competing deletion as absence', async () => {
    const test = await setup()
    const sessionId = await test.stored('competing-delete')
    vi.spyOn(test.ctx.sessionPersistence, 'delete').mockResolvedValueOnce(false)
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'not-found' })
  })

  it('reports absence when the final postflight no longer finds the cold artifact', async () => {
    const test = await setup()
    const sessionId = await test.stored('postflight-missing')
    const snapshot = await test.ctx.sessionPersistence.stat(sessionId)
    vi.spyOn(test.ctx.sessionPersistence, 'stat').mockResolvedValueOnce(snapshot).mockResolvedValueOnce(undefined)
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'not-found' })
  })

  it('normalizes unsupported formats and unverified storage failures', async () => {
    const test = await setup()
    const sessionId = await test.stored('failure')
    vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
    const remove = vi.spyOn(test.ctx.sessionPersistence, 'delete')
    remove.mockRejectedValueOnce(new SessionAlreadyOwnedError(sessionId))
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toMatchObject({ code: 'in-use' })
    remove.mockRejectedValueOnce(new Error('disk unavailable'))
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'failed', message: 'Deletion could not be verified. Refresh stored sessions before retrying.' })
    const stat = vi.spyOn(test.ctx.sessionPersistence, 'stat')
    stat.mockRejectedValueOnce(new SessionFormatUnsupportedError('Unsupported format'))
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toMatchObject({ code: 'unsupported' })
    expect(await test.ctx.sessionPersistence.stat(sessionId)).toBeDefined()
    remove.mockRejectedValueOnce(new SessionPersistenceNotFoundError(sessionId))
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toMatchObject({ code: 'not-found' })
  })
})
