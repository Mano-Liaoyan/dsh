/** The authorization Remote namespace: flow listing, streaming attempts, and sign-out. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError, remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationController from '../src/authorization.ts'
import type { AuthorizationAnswer, AuthorizationAttemptEvent } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const KEY = credentialKey('test', 'flow')

/** One uplink the test feeds after the flow asks its question. */
interface Channel<T> {
  readonly source: AsyncIterable<T>
  push(item: T): void
}

/** A queue-backed async iterable standing in for the Gateway's uplink. */
function channel<T>(): Channel<T> {
  const items: T[] = []
  let wake: (() => void) | undefined
  return {
    source: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (items.length > 0) yield items.shift() as T
          await new Promise<void>((resolve) => { wake = resolve })
          wake = undefined
        }
      },
    },
    push(item) {
      items.push(item)
      wake?.()
      wake = undefined
    },
  }
}

/** A context with the credential store, the seam, and this namespace. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationController)
  return ctx
}

/** Register one flow with an implementation the test drives. */
function register(ctx: Context, run: (session: AuthorizationSession) => Promise<void>, key: CredentialKey = KEY): void {
  ctx.authorization.registerFlow({
    key,
    label: 'Test provider',
    methods: [{ id: 'oauth', label: 'Sign in with Test' }, { id: 'api-key', label: 'API key' }],
    run,
  })
}

/** A controller bound to a Remote invocation whose uplink the test owns. */
function remote(ctx: Context, uplink: AsyncIterable<AuthorizationAnswer>, signal: AbortSignal): AuthorizationController {
  const invocation: RemoteInvocation = {
    request: { namespace: 'authorization', method: 'attempt', args: {} },
    service: 'authorizationController',
    signal,
    peer: {
      id: 'test-peer' as PeerId, ctx, principal: { kind: 'owner' }, interactions: 'answer', signal,
      dispose: () => Promise.resolve(),
    },
    uplink: <In>() => uplink as AsyncIterable<In>,
  }
  return ctx.extend({ invocation }).authorizationController
}

describe('the authorization Remote namespace', () => {
  it('publishes its namespace from its own service key', async () => {
    const ctx = await boot()
    expect(ctx.authorizationController.typertRemote.serviceKey).toBe('authorizationController')
    expect(ctx.authorizationController.typertRemote.namespace).toBe('authorization')
    expect(remoteMethods(ctx.authorizationController)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'attempt', invocation: { kind: 'direct' }, mode: 'stream' },
      { method: 'signOut', invocation: { kind: 'direct' } },
    ])
  })

  it('reports the actionable configuration error while the seam is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthorizationController)
    const failure = await ctx.authorizationController.list().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'gateway/internal',
      message: 'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
      details: {},
    })
    const iterator = ctx.authorizationController
      .attempt('test/flow', undefined, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/internal' })
    await expect(ctx.authorizationController.signOut('test/flow')).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('lists each flow with its halves, methods, and stored-record state', async () => {
    const ctx = await boot()
    register(ctx, () => Promise.resolve())
    const before = await ctx.authorizationController.list()
    expect(before).toEqual([{
      key: 'test/flow',
      scope: 'test',
      id: 'flow',
      label: 'Test provider',
      methods: [
        { id: 'oauth', label: 'Sign in with Test' },
        { id: 'api-key', label: 'API key' },
      ],
      inFlight: false,
      authorized: false,
    }])

    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({
      kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
    }))
    expect(await ctx.authorizationController.list()).toEqual([expect.objectContaining({
      key: 'test/flow', authorized: true, credentialKind: 'grant',
    })])
  })

  it('streams notices, asks its question, and settles authorized', async () => {
    const ctx = await boot()
    let answer = ''
    register(ctx, async (session) => {
      session.notify({ message: 'Open the page', url: 'https://example.test/auth', code: 'ABC-123' })
      answer = await session.prompt({ kind: 'secret', message: 'Paste the code', placeholder: 'ABC-' })
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({
        kind: 'grant', payload: { type: 'oauth', access: 'a', refresh: 'r', expires: 1 },
      }))
    })
    const uplink = channel<AuthorizationAnswer>()
    const abort = new AbortController()
    const controller = remote(ctx, uplink.source, abort.signal)
    const frames: AsyncIterator<AuthorizationAttemptEvent> = controller
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()

    expect(await frames.next()).toEqual({
      done: false,
      value: {
        type: 'notice',
        notice: { message: 'Open the page', url: 'https://example.test/auth', code: 'ABC-123' },
      },
    })
    const prompt = await frames.next()
    expect(prompt.value).toEqual({
      type: 'prompt',
      prompt: { id: 'prompt-1', kind: 'secret', message: 'Paste the code', placeholder: 'ABC-' },
    })
    if (prompt.done === true) throw new Error('expected a prompt frame')
    const frame = prompt.value
    if (frame.type !== 'prompt') throw new Error('expected a prompt frame')
    uplink.push({ promptId: frame.prompt.id, value: 'typed' })

    expect(await frames.next()).toEqual({ done: false, value: { type: 'settled', status: 'authorized' } })
    expect(await frames.next()).toEqual({ done: true, value: undefined })
    expect(answer).toBe('typed')
    expect((await ctx.authorizationController.list())[0]).toMatchObject({ authorized: true, credentialKind: 'grant' })
  })

  it('withdraws a question the flow retired and reports the flow failure', async () => {
    const ctx = await boot()
    const withdraw = new AbortController()
    register(ctx, session => session.prompt({
      kind: 'text', message: 'Paste the code', signal: withdraw.signal,
    }).then(() => Promise.resolve()))
    const abort = new AbortController()
    const frames = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    expect((await frames.next()).value).toMatchObject({ type: 'prompt' })
    withdraw.abort()
    expect(await frames.next()).toEqual({
      done: false,
      value: { type: 'prompt-withdrawn', promptId: 'prompt-1' },
    })
    const failure = await frames.next().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/rejected', details: { key: 'test/flow' } })
  })

  it('ignores a late answer to a question the flow already withdrew', async () => {
    const ctx = await boot()
    const withdraw = new AbortController()
    register(ctx, async (session) => {
      await session.prompt({
        kind: 'text', message: 'Paste the code', signal: withdraw.signal,
      }).catch(() => { /* a browser callback won the race */ })
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'sk-test' }))
    })
    const uplink = channel<AuthorizationAnswer>()
    const abort = new AbortController()
    const frames = remote(ctx, uplink.source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    expect((await frames.next()).value).toMatchObject({ type: 'prompt' })
    withdraw.abort()
    expect(await frames.next()).toEqual({
      done: false,
      value: { type: 'prompt-withdrawn', promptId: 'prompt-1' },
    })
    uplink.push({ promptId: 'prompt-1', value: 'too late' })
    expect(await frames.next()).toEqual({ done: false, value: { type: 'settled', status: 'authorized' } })
  })

  it('settles cancelled when the surface withdraws the attempt', async () => {
    const ctx = await boot()
    register(ctx, session => session.prompt({ kind: 'text', message: 'Paste the code' }).then(() => Promise.resolve()))
    const abort = new AbortController()
    const frames = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    expect((await frames.next()).value).toMatchObject({ type: 'prompt' })
    abort.abort()
    expect(await frames.next()).toEqual({ done: false, value: { type: 'settled', status: 'cancelled' } })
    expect(await frames.next()).toEqual({ done: true, value: undefined })
  })

  it('maps a flow failure to the namespace refusal without exposing prompt answers', async () => {
    const ctx = await boot()
    register(ctx, () => Promise.reject(new Error('the provider refused')) )
    const abort = new AbortController()
    const frames = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    const failure = await frames.next().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'authorization/rejected',
      message: 'the provider refused',
      details: { key: 'test/flow' },
    })
  })

  it('refuses a second attempt while one is running', async () => {
    const ctx = await boot()
    register(ctx, session => session.prompt({ kind: 'text', message: 'Paste the code' }).then(() => Promise.resolve()))
    const abort = new AbortController()
    const first = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    expect((await first.next()).value).toMatchObject({ type: 'prompt' })
    const second = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    const failure = await second.next().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/rejected' })
  })

  it('removes a stored record and refuses keys no flow owns', async () => {
    const ctx = await boot()
    register(ctx, () => Promise.resolve())
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'sk-test' }))
    await ctx.authorizationController.signOut('test/flow')
    expect(await ctx.authorizationController.list()).toEqual([expect.objectContaining({ authorized: false })])
    const failure = await ctx.authorizationController.signOut('test/missing').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    await expect(ctx.authorizationController.signOut('not a key')).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })

  it('requires the Remote uplink a prompt answer travels on', async () => {
    const ctx = await boot()
    register(ctx, () => Promise.resolve())
    const iterator = ctx.authorizationController
      .attempt('test/flow', 'oauth', new AbortController().signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({
      code: 'gateway/internal',
      message: expect.stringContaining('invocation uplink') as string,
    })
  })
})

describe('authorization wire details', () => {
  it('restates every question kind and drops every optional field it was not given', async () => {
    const ctx = await boot()
    register(ctx, async (session) => {
      session.notify({ message: 'Just text' })
      await session.prompt({ kind: 'text', message: 'Text only' })
      await session.prompt({ kind: 'secret', message: 'Secret only' })
      await session.prompt({
        kind: 'select', message: 'Pick', options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', description: 'Bee' },
        ],
      })
      await session.prompt({ kind: 'text', message: 'With placeholder', placeholder: 'P' })
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'sk-test' }))
    })
    const uplink = channel<AuthorizationAnswer>()
    const abort = new AbortController()
    const frames = remote(ctx, uplink.source, abort.signal)
      .attempt('test/flow', undefined, abort.signal)[Symbol.asyncIterator]()

    expect((await frames.next()).value).toEqual({ type: 'notice', notice: { message: 'Just text' } })
    expect((await frames.next()).value).toEqual({
      type: 'prompt', prompt: { id: 'prompt-1', kind: 'text', message: 'Text only' },
    })
    uplink.push({ promptId: 'prompt-1', value: 'a' })
    expect((await frames.next()).value).toEqual({
      type: 'prompt', prompt: { id: 'prompt-2', kind: 'secret', message: 'Secret only' },
    })
    uplink.push({ promptId: 'prompt-2', value: 'b' })
    expect((await frames.next()).value).toEqual({
      type: 'prompt',
      prompt: {
        id: 'prompt-3', kind: 'select', message: 'Pick', options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B', description: 'Bee' },
        ],
      },
    })
    uplink.push({ promptId: 'prompt-3', value: 'b' })
    expect((await frames.next()).value).toEqual({
      type: 'prompt', prompt: { id: 'prompt-4', kind: 'text', message: 'With placeholder', placeholder: 'P' },
    })
    uplink.push({ promptId: 'prompt-4', value: 'c' })
    expect((await frames.next()).value).toEqual({ type: 'settled', status: 'authorized' })
  })

  it('drops a report a flow makes after the attempt settled', async () => {
    const ctx = await boot()
    let late: (() => void) | undefined
    register(ctx, async (session) => {
      late = () => { session.notify({ message: 'too late' }) }
      await ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'api-key', key: 'sk-test' }))
    })
    const abort = new AbortController()
    const frames = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    expect((await frames.next()).value).toEqual({ type: 'settled', status: 'authorized' })
    expect(() => { late?.() }).not.toThrow()
  })

  it('refuses a question asked after the attempt was withdrawn', async () => {
    const ctx = await boot()
    const proceed = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    let asked: Promise<unknown> | undefined
    register(ctx, async (session) => {
      started.resolve(undefined)
      await proceed.promise
      asked = session.prompt({ kind: 'text', message: 'Late question' }).catch((error: unknown) => error)
    })
    const abort = new AbortController()
    const frames = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    const first = frames.next()
    await started.promise
    abort.abort()
    expect((await first).value).toEqual({ type: 'settled', status: 'cancelled' })
    proceed.resolve(undefined)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(asked).toBeDefined()
    await expect(asked).resolves.toBeInstanceOf(Error)
  })

  it('refuses an answer to a question the flow never asked', async () => {
    const ctx = await boot()
    register(ctx, async (session) => { await session.prompt({ kind: 'text', message: 'Q' }) })
    const uplink = channel<AuthorizationAnswer>()
    const abort = new AbortController()
    const frames = remote(ctx, uplink.source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    expect((await frames.next()).value).toMatchObject({ type: 'prompt' })
    uplink.push({ promptId: 'never-asked', value: 'x' })
    const failure = await frames.next().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it.each([
    ['a literal', 'carrier down'],
    ['an Error', new Error('carrier error')],
  ])('reports a broken uplink with %s as an internal failure', async (_label, broken) => {
    const ctx = await boot()
    register(ctx, () => new Promise(() => { /* held until the broken uplink withdraws it */ }))
    async function* failing(): AsyncGenerator<AuthorizationAnswer> {
      throw broken
    }
    const abort = new AbortController()
    const frames = remote(ctx, failing(), abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    const failure = await frames.next().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({
      code: 'gateway/internal',
      message: broken instanceof Error ? broken.message : broken,
    })
  })

  it('cancels when its consumer stops reading', async () => {
    const ctx = await boot()
    register(ctx, async (session) => {
      session.notify({ message: 'one frame' })
      await new Promise(() => { /* never settles */ })
    })
    const abort = new AbortController()
    const frames = remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
    expect(await frames.next()).toEqual({
      done: false,
      value: { type: 'notice', notice: { message: 'one frame' } },
    })
    await frames.return?.(undefined)
    expect(await frames.next()).toEqual({ done: true, value: undefined })
  })

  it('passes a flow whose own failure is already a Remote refusal through unchanged', async () => {
    const ctx = await boot()
    const refusal = new RemoteError('gateway/bad-request', 'already typed', {})
    register(ctx, () => Promise.reject(refusal))
    const abort = new AbortController()
    const failure = await remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
      .next().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request', message: 'already typed' })
  })

  it('reports a non-Error flow failure with its literal text', async () => {
    const ctx = await boot()
    register(ctx, async () => { throw { toString: () => 'literal failure' } })
    const abort = new AbortController()
    const failure = await remote(ctx, channel<AuthorizationAnswer>().source, abort.signal)
      .attempt('test/flow', 'oauth', abort.signal)[Symbol.asyncIterator]()
      .next().catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'authorization/rejected', message: 'literal failure' })
  })
})
