/** Creator-authorized release excludes activation until the caller's operation settles. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentSessionActivationBlockedError } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const contexts: Context[] = []
const roots: string[] = []
const releaseGates: Array<() => void> = []
function gate() {
  const deferred = Promise.withResolvers<undefined>()
  const resolve = (): void => { deferred.resolve(undefined) }
  releaseGates.push(resolve)
  return { promise: deferred.promise, resolve }
}
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(loop = true): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-release-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  if (loop) await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
  return ctx
}

describe('creator-owned Session release', () => {
  it('releases an idle Agent, awaits scoped cleanup and closes its writer before the callback continues', async () => {
    const ctx = await harness()
    const id = SessionId('idle-release')
    const cleaning = gate()
    const cleaned = gate()
    const handle = await ctx.agents.create({ sessionId: id, setup(agentCtx) {
      agentCtx.effect(() => async () => { cleaning.resolve(); await cleaned.promise })
    } })
    await ctx.sessionPersistence.flush()
    let continued = false
    const releasing = ctx.agents.withSessionRelease(id, async (release) => {
      expect(await release()).toBe(true)
      expect(await release()).toBe(true)
      continued = true
      expect(ctx.agents.get(id)).toBeUndefined()
      expect(ctx.sessions.get(id)).toBeUndefined()
      const writer = await ctx.sessionPersistence.open(id, 'write')
      await writer.close()
      return 'released'
    })
    try {
      await cleaning.promise
      expect(continued).toBe(false)
      expect(ctx.agents.get(id)).toBe(handle.agent)
      await expect(ctx.sessionPersistence.open(id, 'write')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    } finally {
      cleaned.resolve()
    }
    expect(await releasing).toEqual({ allowed: true, value: 'released' })
    await handle.dispose()
  })

  it('cancels a running request and waits for its driver cleanup and final durable events', async () => {
    const ctx = await harness()
    const entered = gate()
    const cancelled = gate()
    const settle = gate()
    ctx.on('llm/stream', async function* (request, _next) {
      if (request.signal === undefined) throw new Error('request signal missing')
      const signal = request.signal
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      entered.resolve()
      await new Promise<void>((resolve) => {
        if (signal.aborted) { resolve(); return }
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      cancelled.resolve()
      await settle.promise
      throw new Error('request cancelled')
    })
    const id = SessionId('running-release')
    const { agent } = await ctx.agents.create({ sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await entered.promise
    let continued = false
    const releasing = ctx.agents.withSessionRelease(id, async (release) => {
      const result = await release()
      continued = true
      return result
    })
    try {
      await cancelled.promise
      expect(continued).toBe(false)
      expect(ctx.agents.get(id)).toBe(agent)
    } finally {
      settle.resolve()
    }
    expect(await releasing).toEqual({ allowed: true, value: true })
    expect(ctx.sessions.get(id)).toBeUndefined()
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      const { events } = await reader.read()
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'disposed' } } } })
    } finally {
      await reader.close()
    }
  })

  it('excludes every create/resume path before persistence and releases exclusion after callback failure', async () => {
    const ctx = await harness()
    const id = SessionId('excluded-cold')
    const entered = gate()
    const finish = gate()
    const create = vi.spyOn(ctx.sessionPersistence, 'create')
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    const excluding = ctx.agents.withSessionRelease(id, async (release) => {
      expect(await release()).toBe(true)
      entered.resolve()
      await finish.promise
      throw new Error('operation failed')
    })
    const rejected = expect(excluding).rejects.toThrow('operation failed')
    try {
      await entered.promise
      await expect(ctx.agents.create({ sessionId: id })).rejects.toBeInstanceOf(AgentSessionActivationBlockedError)
      await expect(ctx.agentLoop.create(id)).rejects.toBeInstanceOf(AgentSessionActivationBlockedError)
      await expect(ctx.agents.resume({ resumeSessionId: id })).rejects.toBeInstanceOf(AgentSessionActivationBlockedError)
      expect(await ctx.agents.withSessionRelease(id, async () => 'not admitted')).toEqual({ allowed: false })
      expect(create).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      const other = await ctx.agents.create({ sessionId: SessionId('other-identity') })
      await other.dispose()
    } finally {
      finish.resolve()
    }
    await rejected
    const retry = await ctx.agents.create({ sessionId: id })
    await retry.dispose()
  })

  it('joins already-admitted creation before offering the release capability', async () => {
    const ctx = await harness()
    const id = SessionId('admitted-create')
    const setup = gate()
    const finish = gate()
    const creating = ctx.agents.create({ sessionId: id, async setup() { setup.resolve(); await finish.promise } })
    await setup.promise
    let offered = false
    const releasing = ctx.agents.withSessionRelease(id, async (release) => { offered = true; return release() })
    try {
      await expect(ctx.agents.create({ sessionId: id })).rejects.toBeInstanceOf(AgentSessionActivationBlockedError)
      expect(offered).toBe(false)
    } finally {
      finish.resolve()
    }
    await creating
    expect(await releasing).toEqual({ allowed: true, value: true })
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('allows a preflight refusal without releasing the loaded Agent', async () => {
    const ctx = await harness()
    const id = SessionId('preflight-refusal')
    const { agent } = await ctx.agents.create({ sessionId: id })
    expect(await ctx.agents.withSessionRelease(id, async () => 'policy-refused')).toEqual({ allowed: true, value: 'policy-refused' })
    expect(ctx.agents.get(id)).toBe(agent)
    expect(ctx.sessions.get(id)).toBe(agent.session)
    expect(await ctx.agents.withSessionRelease(id, release => release())).toEqual({ allowed: true, value: true })
  })

  it('does not release an attached Session owned outside the factory', async () => {
    const ctx = await harness()
    const id = SessionId('foreign-session')
    const foreign = ctx.sessions.create(id)
    expect(await ctx.agents.withSessionRelease(id, release => release())).toEqual({ allowed: true, value: false })
    expect(ctx.sessions.get(id)).toBe(foreign)
  })

  it('reports teardown failures without running dependent destructive work', async () => {
    const ctx = await harness()
    const id = SessionId('failed-release')
    const create = ctx.sessionPersistence.create.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'create').mockImplementationOnce(async (...args) => {
      const stored = await create(...args)
      const close = stored.close.bind(stored)
      vi.spyOn(stored, 'close').mockImplementationOnce(async () => {
        await close()
        throw new Error('writer close failed')
      })
      return stored
    })
    await ctx.agents.create({ sessionId: id })
    await ctx.sessionPersistence.flush()
    let destructiveWork = false
    await expect(ctx.agents.withSessionRelease(id, async (release) => {
      await release()
      destructiveWork = true
    })).rejects.toThrow('writer close failed')
    expect(destructiveWork).toBe(false)
    expect(await ctx.sessionPersistence.stat(id)).toBeDefined()
    const resumed = await ctx.agents.resume({ resumeSessionId: id })
    await resumed.dispose()
  })

  it('fails closed when the factory does not offer creator-authorized release', async () => {
    const ctx = await harness(false)
    const callback = vi.fn(async () => true)
    expect(await ctx.agents.withSessionRelease(SessionId('unsupported'), callback)).toEqual({ allowed: false })
    ctx.agents.setFactory({
      createAgent: async () => { throw new Error('not used') },
      resume: async () => { throw new Error('not used') },
    })
    expect(await ctx.agents.withSessionRelease(SessionId('unsupported'), callback)).toEqual({ allowed: false })
    expect(callback).not.toHaveBeenCalled()
  })
})
