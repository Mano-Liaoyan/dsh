import { afterEach, expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { harness } from './harness.ts'

const fixtures: Awaited<ReturnType<typeof harness>>[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(fixtures.splice(0).map(item => item.dispose())) })

it('loads the opt-in service through YAML, deletes committed data, and removes its tool on unload', async () => {
  const test = await harness()
  fixtures.push(test)
  const { ctx, entry } = test
  const sessionId = await test.stored('inactive')
  const events: string[] = []
  ctx.on('session-persistence/deleted', (id) => { events.push(id) })
  expect(ctx.tools.definitions().map(tool => tool.name)).toContain('session_delete')
  const definition = ctx.tools.definitions().find(tool => tool.name === 'session_delete')!
  expect({ description: definition.description, parameters: definition.parameters }).toMatchInlineSnapshot(`
    {
      "description": "Permanently delete one session after human approval, stopping it first if loaded or running. This cannot be undone. The calling session, sessions with reminders, and sessions with subagent or lineage references cannot be deleted.",
      "parameters": {
        "properties": {
          "confirmed": {
            "description": "Set true only when the user has requested permanent deletion of this exact session. A separate approval is still required for this call.",
            "type": "boolean",
          },
          "session_id": {
            "description": "Exact stored session id to permanently delete.",
            "type": "string",
          },
        },
        "required": [
          "session_id",
          "confirmed",
        ],
        "type": "object",
      },
    }
  `)
  expect(definition.presentCall?.({ session_id: sessionId, confirmed: true })).toEqual({
    card: 'generic', title: 'Delete stored session', kind: 'other', rawInput: { session_id: sessionId, confirmed: true },
  })
  const marker = remoteMethods(ctx.sessionDelete).find(method => method.method === 'delete')!
  expect(marker.resources!.session!({ sessionId, confirmed: true })).toBe(sessionId)
  expect(await ctx.sessionDelete.delete({ sessionId, confirmed: true })).toEqual({ sessionId, code: 'deleted' })
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
  expect(events).toEqual([sessionId])
  expect(ctx.sessions.get(sessionId)).toBeUndefined()
  const probe = ctx.sessions.create(SessionId('projection-hmr'))
  expect(ctx.sessionProjections.checkpoint(probe)).toHaveProperty('sessionDeleteDependencies.val', false)
  await entry.fiber!.dispose()
  expect(ctx.sessionProjections.checkpoint(probe)).not.toHaveProperty('sessionDeleteDependencies')
  probe.append('subagent/catalog', { version: 0, childId: SessionId('hmr-child'), childCreatedAt: 1, mode: 'one-shot' })
  expect(ctx.get('sessionDelete')).toBeUndefined()
  expect(ctx.tools.definitions().map(tool => tool.name)).not.toContain('session_delete')
  await entry.init()
  await entry.fiber!.await()
  expect(ctx.tools.definitions().filter(tool => tool.name === 'session_delete')).toHaveLength(1)
  expect(ctx.sessionProjections.checkpoint(probe)).toHaveProperty('sessionDeleteDependencies.val', true)
  expect(ctx.sessionProjections.snapshot(probe).values).not.toHaveProperty('sessionDeleteDependencies')
})

it('enforces real approval in the executor and protects the calling Agent', async () => {
  const test = await harness()
  fixtures.push(test)
  const { ctx } = test
  const sessionId = SessionId('approved-target')
  const target = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
  await ctx.sessions.flush(target.agent.session)
  const standalone = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('standalone'), name: 'session_delete', arguments: JSON.stringify({ session_id: sessionId, confirmed: true }) }],
    signal: new AbortController().signal,
  })
  expect(standalone.results[0]!.result).toMatchObject({ isError: false, value: JSON.stringify({ sessionId, code: 'confirmation-required' }) })
  const agent = test.agent()
  agent.session.append('turn/start', { turn: 1 })
  const run = (target: string, confirmed = true) => ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('delete-call'), name: 'session_delete', arguments: JSON.stringify({ session_id: target, confirmed }) }],
    agent, signal: new AbortController().signal,
  })
  const own = await run(agent.session.id)
  expect(own.results[0]!.result).toMatchObject({ isError: false, value: JSON.stringify({ sessionId: agent.session.id, code: 'in-use' }) })
  // confirmed:true cannot substitute for an unavailable human answerer.
  const refused = await run(sessionId)
  expect(refused.results[0]!.result).toMatchObject({ isError: false, value: JSON.stringify({ sessionId, code: 'confirmation-required' }) })
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeDefined()
  ctx.on('approval/request', async () => 'allowed-once')
  const cancelled = await run(sessionId, false)
  expect(cancelled.results[0]!.result).toMatchObject({ isError: false, value: JSON.stringify({ sessionId, code: 'confirmation-required' }) })
  const deleted = await run(sessionId)
  expect(deleted.results[0]!.result).toMatchObject({ isError: false, value: JSON.stringify({ sessionId, code: 'deleted' }) })
  expect(agent.session.ownEvents().filter(event => event.type === 'approval/decided').map(event => event.data))
    .toEqual([expect.objectContaining({ outcome: 'unavailable' }), expect.objectContaining({ outcome: 'allowed-once' })])
  expect(await ctx.sessionPersistence.stat(sessionId)).toBeUndefined()
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
})
