/**
 * Host owner of the `authorization` Remote namespace: the human-guided sign-in
 * flows a configuration surface runs, carried to the page that started them.
 *
 * The seam itself owns the conversation protocol and the credential write; this
 * namespace owns only the wire obligations around it — enumerating flows with
 * their stored-record state, streaming notices and questions, collecting the
 * answers on the same logical stream, and reporting a settlement.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt, AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type { CredentialKey, CredentialRecordEntry } from '@deepseek-ai/dsh-credentials'
import {
  credentialKeyId, credentialKeyScope, parseCredentialKey,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import {
  Remote, RemoteError, TypertRemoteService, remoteErrorOf, type RemoteStream,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  AuthorizationAnswer, AuthorizationAttemptEvent, AuthorizationFlowView, AuthorizationMethodView,
  AuthorizationNoticeView, AuthorizationPromptOptionView, AuthorizationPromptView,
} from './types.ts'

/** The pi-ai flow label is provider-owned English copy; only its shape is copied here. */
function methodView(method: { readonly id: string; readonly label: string }): AuthorizationMethodView {
  return { id: method.id, label: method.label }
}

/**
 * Copy exactly the fields {@link AuthorizationNoticeView} declares. A flow
 * that attached extras must not widen what a page receives.
 * @param notice - the flow's report.
 * @returns the wire view.
 */
function noticeView(notice: AuthorizationNotice): AuthorizationNoticeView {
  return {
    message: notice.message,
    ...notice.url === undefined ? {} : { url: notice.url },
    ...notice.code === undefined ? {} : { code: notice.code },
  }
}

/** Copy one select option field by field, for the same reason as {@link noticeView}. */
function optionView(option: { readonly id: string; readonly label: string; readonly description?: string }): AuthorizationPromptOptionView {
  return {
    id: option.id,
    label: option.label,
    ...option.description === undefined ? {} : { description: option.description },
  }
}

/**
 * Restate one question with the identity its answer addresses.
 * @param id - the attempt-local question identity.
 * @param prompt - what the flow asked.
 * @returns the wire view.
 */
function promptView(id: string, prompt: AuthorizationPrompt): AuthorizationPromptView {
  switch (prompt.kind) {
    case 'select':
      return { id, kind: 'select', message: prompt.message, options: prompt.options.map(optionView) }
    case 'secret':
      return {
        id,
        kind: 'secret',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    case 'text':
      return {
        id,
        kind: 'text',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
  }
}

/** The Error a withdrawn operation rejects with, even when a synthetic signal carries no Error reason. */
function abortFailure(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback)
}

/** One question waiting for its answer on the client's uplink. */
interface PendingPrompt {
  /** The wire identity echoed by the answer. */
  readonly id: string
  /** Stop observing the flow's own withdrawal signal. */
  release(): void
  /** Deliver the human's answer to the flow. */
  resolve(value: string): void
  /** Withdraw the question locally; the flow learns through its own signal. */
  reject(reason: Error): void
}

/**
 * The frames one attempt has produced, plus the questions it is waiting on.
 *
 * A flow talks back synchronously, while the Remote stream pulls frames on
 * demand; the queue bridges the two. Questions are held here rather than in a
 * Context so one attempt's answers can never reach another's flow.
 */
class AttemptQueue {
  private readonly frames: AuthorizationAttemptEvent[] = []
  private readonly prompts = new Map<string, PendingPrompt>()
  /** Question ids that no longer accept an answer: answered, withdrawn, or settled by their attempt. */
  private readonly closed = new Set<string>()
  private nextPrompt = 0
  private ended = false
  private wake: (() => void) | undefined

  /** Append one frame for the next pull. */
  push(frame: AuthorizationAttemptEvent): void {
    if (this.ended) return
    this.frames.push(frame)
    this.wake?.()
    this.wake = undefined
  }

  /** The interaction handed to `ctx.authorization.begin()`. */
  interaction(signal: AbortSignal): AuthorizationInteraction {
    return {
      notify: (notice) => { this.push({ type: 'notice', notice: noticeView(notice) }) },
      prompt: prompt => this.prompt(prompt, signal),
    }
  }

  /** Ask the human one question and wait for the uplink answer. */
  private prompt(prompt: AuthorizationPrompt, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(abortFailure(signal, 'the sign-in attempt was withdrawn'))
    const id = `prompt-${String(++this.nextPrompt)}`
    return new Promise<string>((resolve, reject) => {
      const withdraw = (): void => {
        const pending = this.prompts.get(id)
        /* v8 ignore next -- an answered question removes this listener with the entry it would find */
        if (pending === undefined) return
        this.prompts.delete(id)
        this.closed.add(id)
        pending.release()
        this.push({ type: 'prompt-withdrawn', promptId: id })
        /* v8 ignore next -- a real AbortSignal always carries a reason; the fallback keeps a synthetic one from rejecting with undefined */
        reject(abortFailure(prompt.signal ?? signal, 'the sign-in question was withdrawn'))
      }
      const release = (): void => { prompt.signal?.removeEventListener('abort', withdraw) }
      prompt.signal?.addEventListener('abort', withdraw, { once: true })
      this.prompts.set(id, {
        id,
        release,
        resolve: (value) => {
          release()
          resolve(value)
        },
        reject: (reason) => {
          release()
          reject(reason)
        },
      })
      this.push({ type: 'prompt', prompt: promptView(id, prompt) })
    })
  }

  /** Deliver one uplink answer to the flow that asked. */
  answer(answer: AuthorizationAnswer): void {
    const pending = this.prompts.get(answer.promptId)
    if (pending === undefined) {
      // A question the flow already withdrew (a browser callback won the race
      // against a typed code) may still receive its answer; that answer is
      // stale, not a protocol error. A question this attempt never asked is.
      if (this.closed.has(answer.promptId)) return
      throw new RemoteError(
        'gateway/bad-request',
        `no sign-in question "${answer.promptId}" is waiting for an answer`,
        {},
      )
    }
    this.prompts.delete(pending.id)
    this.closed.add(pending.id)
    pending.resolve(answer.value)
  }

  /** End the frame sequence and release every question still waiting. */
  close(reason: Error): void {
    if (this.ended) return
    this.ended = true
    for (const pending of this.prompts.values()) {
      pending.release()
      this.closed.add(pending.id)
      pending.reject(reason)
    }
    this.prompts.clear()
    this.wake?.()
    this.wake = undefined
  }

  /** Yield frames until the sequence ends. */
  async *drain(): AsyncGenerator<AuthorizationAttemptEvent> {
    while (true) {
      while (this.frames.length > 0) yield this.frames.shift() as AuthorizationAttemptEvent
      if (this.ended) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace. One
 * attempt per credential record at a time is the seam's rule; this class adds
 * the per-attempt event stream and uplink that make it usable from a page.
 */
export class AuthorizationController extends TypertRemoteService {
  /** @param ctx - Host context where the authorization seam may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /**
   * List every registered flow with its methods and stored-record state, for a
   * provider card choosing what to offer.
   * @returns one view per flow, in registration order.
   * @throws RemoteError when the authorization seam is absent or the credential store cannot be read.
   */
  @Remote
  async list(): Promise<AuthorizationFlowView[]> {
    const authorization = this.authorization()
    const records = await this.records()
    return authorization.list().map((entry) => {
      const record = records.get(entry.key)
      return {
        key: entry.key,
        scope: credentialKeyScope(entry.key),
        id: credentialKeyId(entry.key),
        label: entry.label,
        methods: entry.methods.map(methodView),
        inFlight: entry.inFlight,
        authorized: record !== undefined,
        ...record === undefined ? {} : { credentialKind: record.kind },
      }
    })
  }

  /**
   * Run one authorization attempt and stream its notices and questions.
   *
   * The stream's uplink carries the answers, so an attempt belongs to exactly
   * the page that opened it. Cancelling the stream (closing the page, pressing
   * Cancel) withdraws the attempt; the flow's own credential write is the only
   * thing that makes it succeed.
   * @param key - the `<scope>/<id>` credential record to authorize.
   * @param method - one method the flow declared; omitted runs its first.
   * @param signal - the stream's lifetime.
   * @returns the attempt's frames, ending after a `settled` frame.
   * @throws RemoteError with code `authorization/rejected` when the flow refuses or fails.
   */
  @Remote({ mode: 'stream' })
  async *attempt(
    key: string,
    method: string | undefined,
    signal: AbortSignal,
  ): RemoteStream<AuthorizationAttemptEvent, AuthorizationAnswer> {
    const branded = this.key(key)
    const authorization = this.authorization()
    const invocation = this.ctx.invocation
    /* v8 ignore next 5 -- generated Remote methods are invoked through the Gateway only; the guard names the in-process misuse. */
    if (invocation === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization.attempt serves a Remote caller only: it needs the invocation uplink that carries prompt answers',
        {},
      )
    }
    const queue = new AttemptQueue()
    const abort = new AbortController()
    const withdrawn = AbortSignal.any([signal, abort.signal])
    let answerFailure: RemoteError | undefined
    void (async () => {
      try {
        for await (const answer of invocation.uplink<AuthorizationAnswer>()) queue.answer(answer)
      } catch (error) {
        answerFailure = error instanceof RemoteError
          ? error
          : new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}, { cause: error })
        abort.abort(answerFailure)
      }
    })()
    let outcome: { readonly ok: true; readonly status: 'authorized' | 'cancelled' }
      | { readonly ok: false; readonly error: unknown } | undefined
    void authorization.begin({
      key: branded,
      ...method === undefined ? {} : { method },
      interaction: queue.interaction(withdrawn),
      signal: withdrawn,
    }).then(
      (settled) => { outcome = { ok: true, status: settled.status } },
      (error: unknown) => { outcome = { ok: false, error } },
    ).finally(() => { queue.close(abortFailure(withdrawn, 'the sign-in attempt ended')) })
    try {
      yield* queue.drain()
    } finally {
      // An early return by the consumer is a cancellation: stop the flow and
      // release anything still waiting, whatever settlement it had reached.
      if (outcome === undefined) abort.abort()
      queue.close(abortFailure(withdrawn, 'the sign-in attempt ended'))
    }
    if (answerFailure !== undefined) throw answerFailure
    /* v8 ignore next -- a normally ended drain implies the attempt settled, which set `outcome` */
    if (outcome === undefined) return
    if (!outcome.ok) throw this.reject(key, outcome.error)
    yield { type: 'settled', status: outcome.status }
  }

  /**
   * Remove the record a sign-in wrote. This forgets the credential locally; it
   * does not tell the issuer, because the seam has no revocation vocabulary.
   * @param key - the `<scope>/<id>` credential record to remove.
   * @throws RemoteError when the key is malformed, no flow owns it, or the store refuses.
   */
  @Remote
  async signOut(key: string): Promise<void> {
    const branded = this.key(key)
    const authorization = this.authorization()
    if (authorization.describe(branded) === undefined) {
      throw new RemoteError(
        'gateway/bad-request',
        `no authorization flow is registered for "${key}", so there is no stored sign-in to remove`,
        {},
      )
    }
    await this.credentials().deleteRecord(branded)
  }

  /** The live authorization seam, or the actionable missing-service failure. */
  private authorization(): AuthorizationService {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
        {},
      )
    }
    return authorization
  }

  /** The credential store every flow is expected to have beside it. */
  private credentials(): CredentialProvider {
    const credentials = this.ctx.get('credentials')
    /* v8 ignore next 7 -- the seam injects the credential store, so it is present whenever a flow can run */
    if (credentials === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        {},
      )
    }
    return credentials
  }

  /** Stored records keyed by their joined key; an absent store has none to report. */
  private async records(): Promise<Map<string, CredentialRecordEntry>> {
    const credentials = this.ctx.get('credentials')
    /* v8 ignore next -- the seam injects the credential store, so an absent one cannot reach a listed flow */
    if (credentials === undefined) return new Map()
    return new Map((await credentials.listRecords()).map(record => [record.key, record]))
  }

  /** Brand one wire key or refuse the request before it reaches a flow. */
  private key(value: string): CredentialKey {
    try {
      return parseCredentialKey(value)
    } catch {
      throw new RemoteError(
        'gateway/bad-request',
        `"${value}" is not a credential record key ("<scope>/<id>")`,
        {},
      )
    }
  }

  /** Restate one flow failure as the namespace's typed refusal. */
  private reject(key: string, error: unknown): RemoteError {
    const remote = remoteErrorOf(error)
    if (remote !== undefined) return remote
    if (error instanceof AuthorizationError) {
      return new RemoteError('authorization/rejected', error.message, { key }, { cause: error })
    }
    return new RemoteError(
      'authorization/rejected',
      error instanceof Error ? error.message : String(error),
      { key },
      { cause: error },
    )
  }
}

export default AuthorizationController
