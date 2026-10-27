import { afterEach, expect, it, vi } from 'vitest'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { harness } from './harness.ts'

const fixtures: Awaited<ReturnType<typeof harness>>[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(item => item.dispose())) })
async function setup(adapter?: LlmAdapter) { const test = await harness(adapter); fixtures.push(test); return test }

it('releases a loaded idle Agent and deletes its durable Session', async () => {
  const { ctx } = await setup()
  const sessionId = SessionId('loaded-idle')
  const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  await ctx.sessions.flush(handle.agent.session)
  expect(ctx.sessions.get(sessionId)).toBe(handle.agent.session)
  expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'deleted' })
  expect(ctx.agents.get(sessionId)).toBeUndefined()
  expect(ctx.sessions.get(sessionId)).toBeUndefined()
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
})

it('releases a new blank Agent without requiring an existing physical artifact', async () => {
  const { ctx } = await setup()
  const sessionId = SessionId('loaded-blank')
  await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'deleted' })
  expect(ctx.sessions.get(sessionId)).toBeUndefined()
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
})

it('keeps loaded Agents untouched when reminders or live child catalogs already prohibit deletion', async () => {
  const { ctx } = await setup()
  const sessionId = SessionId('loaded-reminder')
  const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const reminder = await ctx.schedule.create(sessionId, { title: 'Keep', prompt: 'Keep', after_seconds: 3600 })
  expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'scheduled' })
  expect(ctx.agents.get(sessionId)).toBe(handle.agent)
  expect(ctx.sessions.get(sessionId)).toBe(handle.agent.session)
  await ctx.schedule.delete({ sessionId, id: reminder.id })
  handle.agent.session.append('subagent/catalog', { version: 0, childId: SessionId('child'), childCreatedAt: 1, mode: 'one-shot' })
  expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'related-session' })
  expect(ctx.agents.get(sessionId)).toBe(handle.agent)
})

it('awaits running cancellation and final persistence while excluding concurrent reactivation', async () => {
  const entered = Promise.withResolvers<undefined>()
  const aborted = Promise.withResolvers<undefined>()
  const settle = Promise.withResolvers<undefined>()
  const adapter = new class extends LlmAdapter {
    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const signal = options.signal
      if (signal === undefined) throw new Error('Fixture requires cancellation')
      entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return }
        signal.addEventListener('abort', () => { aborted.resolve(undefined); resolve() }, { once: true })
      })
      await settle.promise
      signal.throwIfAborted()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
  const { ctx } = await setup(adapter)
  const sessionId = SessionId('loaded-running')
  const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run until stopped' }], source: { kind: 'user' } }))
  await entered.promise
  const remove = vi.spyOn(ctx.sessionPersistence, 'delete')
  const deletion = ctx.sessionDelete.delete({ sessionId, confirmed: true })
  try {
    await aborted.promise
    expect(remove).not.toHaveBeenCalled()
    await expect(ctx.agents.resume({ resumeSessionId: sessionId })).rejects.toThrow()
    expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'in-use' })
  } finally { settle.resolve(undefined) }
  expect(await deletion).toEqual({ sessionId, code: 'deleted' })
  expect(ctx.agents.get(sessionId)).toBeUndefined()
  expect(ctx.sessions.get(sessionId)).toBeUndefined()
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
})

it('preserves the log when a reminder appears while shutdown settles', async () => {
  const { ctx } = await setup()
  const sessionId = SessionId('shutdown-reminder-race')
  const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  await ctx.sessions.flush(handle.agent.session)
  const original = ctx.agents.withSessionRelease.bind(ctx.agents)
  vi.spyOn(ctx.agents, 'withSessionRelease').mockImplementation((id, operation) => original(id, release => operation(async () => {
    const released = await release()
    await ctx.schedule.create(sessionId, { title: 'Racing', prompt: 'Keep log', after_seconds: 3600 })
    return released
  })))
  const remove = vi.spyOn(ctx.sessionPersistence, 'delete')
  expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'scheduled' })
  expect(remove).not.toHaveBeenCalled()
  expect(ctx.sessions.get(sessionId)).toBeUndefined()
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeDefined()
})

it('rechecks child catalogs flushed during shutdown before physical deletion', async () => {
  const { ctx } = await setup()
  const sessionId = SessionId('shutdown-catalog-race')
  const handle = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const original = ctx.agents.withSessionRelease.bind(ctx.agents)
  vi.spyOn(ctx.agents, 'withSessionRelease').mockImplementation((id, operation) => original(id, release => operation(async () => {
    handle.agent.session.append('subagent/catalog', { version: 0, childId: SessionId('racing-child'), childCreatedAt: 1, mode: 'one-shot' })
    return release()
  })))
  const remove = vi.spyOn(ctx.sessionPersistence, 'delete')
  expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'related-session' })
  expect(remove).not.toHaveBeenCalled()
  expect(ctx.sessions.get(sessionId)).toBeUndefined()
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeDefined()
})

it('does not delete storage when owner shutdown fails', async () => {
  const test = await setup()
  const sessionId = await test.stored('shutdown-failed')
  const remove = vi.spyOn(test.ctx.sessionPersistence, 'delete')
  vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
  vi.spyOn(test.ctx.agents, 'withSessionRelease').mockRejectedValueOnce(new Error('shutdown did not finish'))
  expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toMatchObject({ code: 'failed' })
  expect(remove).not.toHaveBeenCalled()
  expect(await test.ctx.sessionPersistence.stat(sessionId)).toBeDefined()
})

it('retains cold-only behavior when the installed Host predates the release capability', async () => {
  const test = await setup()
  const sessionId = await test.stored('old-host-cold')
  Object.defineProperty(test.ctx.agents, 'withSessionRelease', { configurable: true, value: undefined })
  try {
    expect(await test.ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'deleted' })
    expect(await test.ctx.sessionDelete.delete({ sessionId: SessionId('old-host-missing'), confirmed: true })).toMatchObject({ code: 'not-found' })
    const raced = await test.stored('old-host-reattached')
    const list = test.ctx.sessionPersistence.list.bind(test.ctx.sessionPersistence)
    vi.spyOn(test.ctx.sessionPersistence, 'list').mockImplementationOnce(async () => {
      test.ctx.sessions.create(raced)
      return list()
    })
    expect(await test.ctx.sessionDelete.delete({ sessionId: raced, confirmed: true })).toEqual({ sessionId: raced, code: 'in-use' })
    const live = test.agent('old-host-loaded')
    expect(await test.ctx.sessionDelete.delete({ sessionId: live.id, confirmed: true })).toEqual({ sessionId: live.id, code: 'in-use' })
    expect(test.ctx.sessions.get(live.id)).toBe(live.session)
  } finally { Reflect.deleteProperty(test.ctx.agents, 'withSessionRelease') }
})
