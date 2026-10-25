/** Provider sign-in store: flow listing, streaming attempts, answers, and sign-out. */
import { describe, expect, it, vi } from 'vitest'
import type {
  AuthorizationAnswer, AuthorizationAttemptEvent, AuthorizationFlowView, AuthorizationPromptView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderSignInStore } from '../src/client/sign-in.ts'
import type { SignInOutcome, SignInSurface } from '../src/client/sign-in.ts'

const KEY = 'llm-pi-ai/anthropic'

const FLOW: AuthorizationFlowView = {
  key: KEY,
  scope: 'llm-pi-ai',
  id: 'anthropic',
  label: 'Anthropic',
  methods: [{ id: 'oauth', label: 'Sign in with Anthropic' }],
  inFlight: false,
  authorized: false,
}

/** One observable attempt stream, fed by the test's own async generator. */
interface ScriptedStream {
  send: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  source: AsyncIterable<AuthorizationAttemptEvent>
}

/**
 * Build one store over a scripted Remote namespace.
 * @param stream - the attempt stream `attempt` returns.
 */
function harness(stream: ScriptedStream = scripted([])) {
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: [FLOW] }))
  const signOut = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  const attempt = vi.fn(() => Object.assign(stream.source, { send: stream.send, dispose: stream.dispose }))
  const ctx = { remote: { authorization: { list, attempt, signOut } } } as never
  const store = new ProviderSignInStore(ctx)
  return { store, list, attempt, signOut, stream }
}

/** A stream whose events come from the given generator factory. */
function scripted(
  events: readonly AuthorizationAttemptEvent[],
  options: { readonly fail?: unknown; readonly sendThrows?: boolean } = {},
): ScriptedStream {
  return {
    send: vi.fn(() => {
      if (options.sendThrows === true) throw new Error('the stream already settled')
    }),
    dispose: vi.fn(),
    source: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event
        if (options.fail !== undefined) throw options.fail
      },
    },
  }
}

/** A surface recording what the store relays. */
function surface(answer: (prompt: AuthorizationPromptView) => Promise<string> = () => Promise.resolve('typed')) {
  return {
    notice: vi.fn(),
    prompt: vi.fn(answer),
    withdrawPrompt: vi.fn(),
    dismiss: vi.fn(),
  } satisfies SignInSurface
}

describe('ProviderSignInStore', () => {
  it('publishes a ready flow listing', async () => {
    const { store, list } = harness()
    expect(store.store.getSnapshot()).toEqual({ status: 'idle', error: null, flows: [] })
    await store.load()
    expect(store.store.getSnapshot()).toEqual({ status: 'ready', error: null, flows: [FLOW] })
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('publishes a refusal and a thrown read as the listing failure', async () => {
    const refused = harness()
    refused.list.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal', message: 'no seam', details: {} } } as never)
    await refused.store.load()
    expect(refused.store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'no seam' })

    const thrown = harness()
    thrown.list.mockRejectedValueOnce(new Error('carrier down'))
    await thrown.store.load()
    expect(thrown.store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'carrier down' })

    const literal = harness()
    literal.list.mockRejectedValueOnce('carrier lost')
    await literal.store.load()
    expect(literal.store.store.getSnapshot()).toMatchObject({ status: 'error', error: 'carrier lost' })
  })

  it('keeps the newest listing when a slow older read settles last', async () => {
    const first = Promise.withResolvers<{ ok: true; value: AuthorizationFlowView[] }>()
    const second = Promise.withResolvers<{ ok: true; value: AuthorizationFlowView[] }>()
    const { store, list } = harness()
    list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const older = store.load()
    const newer = store.load()
    second.resolve({ ok: true, value: [FLOW] })
    await newer
    first.resolve({ ok: true, value: [] })
    await older
    expect(store.store.getSnapshot().flows).toEqual([FLOW])
  })

  it('relays a notice and a question, then reloads on success', async () => {
    const answered = Promise.withResolvers<undefined>()
    const sent: AuthorizationAnswer[] = []
    const stream: ScriptedStream = {
      send: vi.fn((answer: AuthorizationAnswer) => { sent.push(answer); answered.resolve(undefined) }),
      dispose: vi.fn(),
      source: {
        async *[Symbol.asyncIterator]() {
          yield { type: 'notice', notice: { message: 'Open the page', url: 'https://example.test' } }
          yield { type: 'prompt', prompt: { id: 'prompt-1', kind: 'text', message: 'Paste the code' } }
          await answered.promise
          yield { type: 'settled', status: 'authorized' }
        },
      },
    }
    const { store, list } = harness(stream)
    const ui = surface()
    await expect(store.run(KEY, 'oauth', ui, new AbortController().signal))
      .resolves.toEqual({ kind: 'authorized' satisfies SignInOutcome['kind'] })
    expect(ui.notice).toHaveBeenCalledWith({ message: 'Open the page', url: 'https://example.test' })
    expect(sent).toEqual([{ promptId: 'prompt-1', value: 'typed' }])
    expect(ui.dismiss).toHaveBeenCalledTimes(1)
    expect(stream.dispose).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('reports a cancelled settlement without reloading', async () => {
    const { store, list } = harness(scripted([{ type: 'settled', status: 'cancelled' }]))
    const ui = surface()
    await expect(store.run(KEY, 'oauth', ui, new AbortController().signal))
      .resolves.toEqual({ kind: 'cancelled' })
    expect(list).not.toHaveBeenCalled()
    expect(ui.dismiss).toHaveBeenCalledTimes(1)
  })

  it('reports a stream failure as the attempt message', async () => {
    const { store } = harness(scripted([], { fail: new Error('the provider refused') }))
    await expect(store.run(KEY, 'oauth', surface(), new AbortController().signal))
      .resolves.toEqual({ kind: 'failed', message: 'the provider refused' })
    const literal = harness(scripted([], { fail: 'broken' }))
    await expect(literal.store.run(KEY, 'oauth', surface(), new AbortController().signal))
      .resolves.toEqual({ kind: 'failed', message: 'broken' })
  })

  it('reports cancellation when the surface withdrew the attempt', async () => {
    const abort = new AbortController()
    const { store } = harness(scripted([], { fail: new Error('carrier cancelled') }))
    abort.abort()
    await expect(store.run(KEY, 'oauth', surface(), abort.signal)).resolves.toEqual({ kind: 'cancelled' })
  })

  it('fails loud when the stream ends without a settlement', async () => {
    const { store } = harness(scripted([{ type: 'notice', notice: { message: 'Only a notice' } }]))
    await expect(store.run(KEY, 'oauth', surface(), new AbortController().signal))
      .resolves.toEqual({ kind: 'failed', message: 'the sign-in stream ended before it settled' })
  })

  it('reports cancellation when a silent stream ends after the surface withdrew', async () => {
    const abort = new AbortController()
    const { store } = harness(scripted([{ type: 'notice', notice: { message: 'Only a notice' } }]))
    abort.abort()
    await expect(store.run(KEY, 'oauth', surface(), abort.signal)).resolves.toEqual({ kind: 'cancelled' })
  })

  it('drops an answer that arrives after the attempt was withdrawn', async () => {
    const abort = new AbortController()
    const answer = Promise.withResolvers<string>()
    const { store, stream } = harness(scripted([
      { type: 'prompt', prompt: { id: 'prompt-1', kind: 'text', message: 'Paste the code' } },
      { type: 'settled', status: 'cancelled' },
    ]))
    const run = store.run(KEY, 'oauth', surface(() => answer.promise), abort.signal)
    await Promise.resolve()
    abort.abort()
    answer.resolve('too late')
    await expect(run).resolves.toEqual({ kind: 'cancelled' })
    expect(stream.send).not.toHaveBeenCalled()
  })

  it('closes a withdrawn question without sending an answer', async () => {
    const { store, stream } = harness(scripted([
      { type: 'prompt', prompt: { id: 'prompt-1', kind: 'text', message: 'Paste the code' } },
      { type: 'prompt-withdrawn', promptId: 'prompt-1' },
      { type: 'settled', status: 'cancelled' },
    ]))
    const ui = surface(() => new Promise<string>(() => { /* the human never answers */ }))
    await store.run(KEY, 'oauth', ui, new AbortController().signal)
    expect(ui.withdrawPrompt).toHaveBeenCalledWith('prompt-1')
    expect(stream.send).not.toHaveBeenCalled()
  })

  it('ignores an answer the closed stream refuses', async () => {
    const { store } = harness(scripted([
      { type: 'prompt', prompt: { id: 'prompt-1', kind: 'text', message: 'Paste the code' } },
      { type: 'settled', status: 'cancelled' },
    ], { sendThrows: true }))
    await expect(store.run(KEY, 'oauth', surface(), new AbortController().signal))
      .resolves.toEqual({ kind: 'cancelled' })
  })

  it('drops an answer whose question the human dismissed', async () => {
    const { store, stream } = harness(scripted([
      { type: 'prompt', prompt: { id: 'prompt-1', kind: 'text', message: 'Paste the code' } },
      { type: 'settled', status: 'cancelled' },
    ]))
    await store.run(KEY, 'oauth', surface(() => Promise.reject(new Error('dismissed'))), new AbortController().signal)
    expect(stream.send).not.toHaveBeenCalled()
  })

  it('signs out and re-reads the listing, or reports the refusal', async () => {
    const ok = harness()
    await expect(ok.store.signOut(KEY)).resolves.toBeUndefined()
    expect(ok.signOut).toHaveBeenCalledWith(KEY)
    expect(ok.list).toHaveBeenCalledTimes(1)

    const refused = harness()
    refused.signOut.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal', message: 'store down', details: {} } } as never)
    await expect(refused.store.signOut(KEY)).resolves.toBe('store down')
    expect(refused.list).not.toHaveBeenCalled()
  })
})
