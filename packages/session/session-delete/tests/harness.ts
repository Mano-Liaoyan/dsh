/** Isolated Loader composition with real JSONL sessions and Host schedule storage. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Schedule from '@deepseek-ai/dsh-schedule'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Approval from '@deepseek-ai/dsh-user-approval'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionDelete from '../src/index.ts'

/**
 * Load an isolated opt-in composition and retain teardown even when setup rejects.
 * @param adapter - Explicit model behavior; omission supplies a terminal stop response.
 * @returns Real services and helpers limited to this fixture's private temporary root.
 */
export async function harness(adapter?: LlmAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const ctx = new Context()
  const dispose = async () => {
    await ctx.fiber.dispose()
    if (resolve(root) !== root || !root.startsWith(join(tmpdir(), 'dsh-session-delete-'))) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
  try {
    const plugins = new Map<string, unknown>([
      ['sessions', SessionStore], ['persistence', JsonlPersistence], ['projections', Projections],
      ['agents', Agents], ['storage', Storage], ['storage-json', StorageJson], ['storage-domain', StorageDomain],
      ['schedule', Schedule], ['system-prompt', SystemPrompt], ['tools', Tools], ['approval', Approval],
      ['native-executor', NativeExecutor], ['session-delete', SessionDelete], ['llm', LlmRuntime], ['loop', AgentLoop],
    ])
    const config = [
      '- name: sessions', '- name: projections', '- name: agents', '- name: persistence',
      '  config:', `    root: ${JSON.stringify(join(root, 'sessions'))}`, '    compression: none',
      '- name: storage', '- name: storage-json', '  config:', `    root: ${JSON.stringify(join(root, 'storage'))}`,
      '- name: storage-domain', '  config:', '    backend: json', '- name: schedule',
      '- name: system-prompt', '- name: tools', '- name: approval', '- name: native-executor',
      '- name: llm', '- name: loop', '  config:', '    agents: []',
      '- id: delete', '  name: session-delete', '',
    ].join('\n')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, config)
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2', loadCache: new Map(),
      async import(specifier: string) {
        if (!plugins.has(specifier)) throw new Error(`Unexpected plugin: ${specifier}`)
        return plugins.get(specifier)
      },
      register(): never { throw new Error('Unexpected module hook registration') },
      getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
      resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
      load(): never { throw new Error('Unexpected module load') },
    }
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const entry = [...ctx.loader.entries()].find(item => item.options.id === 'delete')!
    await entry.fiber!.await()
    ctx.llm.registerAdapter(['fixture'], adapter ?? new class extends LlmAdapter {
      async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
    }())
    return {
      ctx, entry,
      async stored(id: string, meta: Partial<SessionHeader> = {}) {
        const sessionId = SessionId(id)
        const handle = await ctx.sessionPersistence.create({ version: 4, id: sessionId, createdAt: 1, isSeeded: false, ...meta },
          meta.isSeeded ? { inheritedEventCount: SessionLogOffset(0) } : {})
        try {
          await handle.append([
            { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
            { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
          ])
          await handle.flush()
        } finally { await handle.close() }
        return sessionId
      },
      agent(id = 'caller'): Agent {
        const session = ctx.sessions.create(SessionId(id))
        return {
          id: session.id, session, ctx: ctx.extend(), options: {}, status: 'idle',
          model: unsupportedModel(), inbox: unsupportedInbox(),
          send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
          whenIdle: async () => {}, runMaintenance: operation => operation(new AbortController().signal),
        }
      },
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
