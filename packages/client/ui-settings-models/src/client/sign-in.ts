/**
 * Provider sign-in state for the Models page: the authorization flows the
 * Host offers, each joined to its provider row, plus the one streaming attempt
 * a card can run.
 *
 * The page never holds a credential here. `run()` relays the Host's notices
 * and questions to the card that started the attempt and sends the human's
 * answers back on the same stream; the Host's flow owns the record write.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-models/sign-in
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  AuthorizationAnswer, AuthorizationAttemptEvent, AuthorizationFlowView, AuthorizationNoticeView, AuthorizationPromptView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What the provider cards read: the last flow listing and its failure, if any. */
export interface SignInState {
  /** `idle` before the first read, then the latest read's state. */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Listing failure text; a card renders no controls while it is set. */
  error: string | null
  /** Every registered flow, in Host registration order. */
  flows: readonly AuthorizationFlowView[]
}

/** The parts of the attempt's stream a card's answer pump uses. */
interface AttemptStream {
  /** Send one answer back on the same logical stream. */
  send(answer: AuthorizationAnswer): void
  /** Withdraw the attempt and release the stream. */
  dispose(): void
}

/** What one running attempt tells the card that started it. */
export interface SignInSurface {
  /** Show one one-way report. */
  notice(notice: AuthorizationNoticeView): void
  /** Put one question to the human; resolves with the typed value or option id. */
  prompt(prompt: AuthorizationPromptView): Promise<string>
  /** Close one question the flow no longer needs, without ending the attempt. */
  withdrawPrompt(promptId: string): void
  /** The attempt is over: close whatever the card still shows. */
  dismiss(): void
}

/** How one attempt ended. */
export type SignInOutcome =
  | { readonly kind: 'authorized' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }

/**
 * The Models page's sign-in controller: one flow listing shared by every card,
 * and attempts run against the card's own surface and cancellation signal.
 */
export class ProviderSignInStore {
  /** The listing every provider card selects from. */
  readonly store: SnapshotStore<SignInState> = createSnapshotStore<SignInState>({
    status: 'idle', error: null, flows: [],
  })

  /** Latest listing wins; an older response never overwrites a newer one. */
  private generation = 0

  /** @param ctx - the page plugin's context, whose `remote.authorization` namespace owns these calls. */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Read every registered flow and its stored-record state. A failure is
   * published rather than thrown: sign-in is an enhancement beside the API-key
   * field, so a deployment without the seam keeps the rest of the page usable.
   * @returns resolution after the current listing is published.
   */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.update((state) => { state.status = 'loading'; state.error = null })
    try {
      const response = await this.ctx.remote.authorization.list()
      if (generation !== this.generation) return
      if (response.ok) {
        this.store.update((state) => {
          state.status = 'ready'
          state.error = null
          state.flows = response.value
        })
        return
      }
      this.store.update((state) => { state.status = 'error'; state.error = response.error.message })
    } catch (error) {
      /* v8 ignore next -- the mounted namespace answers through its result envelope; this covers a carrier fault */
      if (generation !== this.generation) return
      this.store.update((state) => {
        state.status = 'error'
        state.error = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Run one attempt against one card's surface.
   *
   * The attempt's stream carries its answers, so closing the card or pressing
   * Cancel (aborting `signal`) withdraws the attempt rather than leaving a
   * question nobody can answer.
   * @param key - the credential record the flow writes.
   * @param method - the flow method the human chose.
   * @param surface - the card's notice and question handlers.
   * @param signal - the card's lifetime; aborting withdraws the attempt.
   * @returns how the attempt ended.
   */
  async run(
    key: string,
    method: string,
    surface: SignInSurface,
    signal: AbortSignal,
  ): Promise<SignInOutcome> {
    const stream = this.ctx.remote.authorization.attempt(key, method, signal)
    let outcome: SignInOutcome | undefined
    try {
      for await (const event of stream) {
        const finished = this.dispatch(event, stream, surface, signal)
        if (finished !== undefined) { outcome = finished; break }
      }
    } catch (error) {
      outcome = signal.aborted
        ? { kind: 'cancelled' }
        : { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    } finally {
      surface.dismiss()
      stream.dispose()
    }
    if (outcome === undefined) {
      outcome = signal.aborted
        ? { kind: 'cancelled' }
        /* v8 ignore next -- the Host always ends a finished attempt with a settled frame */
        : { kind: 'failed', message: 'the sign-in stream ended before it settled' }
    }
    if (outcome.kind === 'authorized') await this.load()
    return outcome
  }

  /**
   * Start the answer task one prompt asks for, without blocking the stream's
   * frame pump: a withdrawal frame must still arrive while the human types.
   */
  private dispatch(
    event: AuthorizationAttemptEvent,
    stream: AttemptStream,
    surface: SignInSurface,
    signal: AbortSignal,
  ): SignInOutcome | undefined {
    switch (event.type) {
      case 'notice':
        surface.notice(event.notice)
        return undefined
      case 'prompt':
        void surface.prompt(event.prompt).then(
          (value) => {
            if (signal.aborted) return
            try {
              stream.send({ promptId: event.prompt.id, value })
            } catch {
              // The attempt settled while this answer was being typed; the
              // settlement it already reported is the outcome that counts.
            }
          },
          () => {
            // A withdrawal or a dismissed card closes the question; the flow
            // learns that through its own prompt signal, not through us.
          },
        )
        return undefined
      case 'prompt-withdrawn':
        surface.withdrawPrompt(event.promptId)
        return undefined
      case 'settled':
        return { kind: event.status === 'authorized' ? 'authorized' : 'cancelled' }
    }
  }

  /**
   * Remove the record a sign-in wrote, then re-read the listing so the card
   * shows the record is gone.
   * @param key - the credential record to remove.
   * @returns the refusal message, or undefined once removed.
   */
  async signOut(key: string): Promise<string | undefined> {
    const response = await this.ctx.remote.authorization.signOut(key)
    if (!response.ok) return response.error.message
    await this.load()
    return undefined
  }
}
