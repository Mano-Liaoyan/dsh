/**
 * Browser-safe failure vocabulary and authorization views of the configuration
 * surfaces this package serves. The redacted settings views live with their
 * seam in `@deepseek-ai/dsh-settings/types`; the authorization vocabulary
 * lives here because only this package puts those flows on the wire.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * A registered authorization flow refused the attempt or reported its own
     * failure. The message is the flow's diagnostic; the details name the
     * credential record, never anything the flow asked the human for.
     */
    'authorization/rejected': { readonly key: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** One way a registered authorization flow can obtain its credential. */
export interface AuthorizationMethodView {
  /** Flow-owned method identifier; the caller echoes it back to start that method. */
  readonly id: string
  /** The flow's own label for the method, such as "Sign in with ChatGPT". */
  readonly label: string
}

/**
 * One registered authorization flow as a provider card sees it. `key` is the
 * `<scope>/<id>` credential record the flow writes; `scope` and `id` repeat
 * its two halves because a card joins flows to providers without parsing.
 */
export interface AuthorizationFlowView {
  /** The credential record the flow writes. */
  readonly key: string
  /** Owning plugin's record scope, such as `llm-pi-ai`. */
  readonly scope: string
  /** The owner's id for this credential, such as its provider route id. */
  readonly id: string
  /** Human-facing name of what is being authorized. */
  readonly label: string
  /** Methods this flow offers, most preferred first. */
  readonly methods: readonly AuthorizationMethodView[]
  /** Whether an attempt for this record is running right now. */
  readonly inFlight: boolean
  /** Whether a credential record currently exists for {@link key}. */
  readonly authorized: boolean
  /** The stored record's kind, present only while {@link authorized}. */
  readonly credentialKind?: 'api-key' | 'grant'
}

/** One one-way report from a running flow. Never carries a secret. */
export interface AuthorizationNoticeView {
  /** What is happening, or what the human must do next. */
  readonly message: string
  /** A page the human must open to continue. */
  readonly url?: string
  /** A short code the human must enter on that page. */
  readonly code?: string
}

/** One choice offered by a `select` prompt. */
export interface AuthorizationPromptOptionView {
  /** Value returned when this option is chosen. */
  readonly id: string
  /** User-facing label. */
  readonly label: string
  /** Optional extra context rendered by capable surfaces. */
  readonly description?: string
}

/**
 * One question a running flow needs answered. `secret` differs from `text`
 * only in presentation; `select` answers with the chosen option's `id`. The
 * `id` addresses the question in {@link AuthorizationAnswer}.
 */
export type AuthorizationPromptView =
  | { readonly id: string; readonly kind: 'text'; readonly message: string; readonly placeholder?: string }
  | { readonly id: string; readonly kind: 'secret'; readonly message: string; readonly placeholder?: string }
  | {
    readonly id: string
    readonly kind: 'select'
    readonly message: string
    readonly options: readonly AuthorizationPromptOptionView[]
  }

/** One frame of a running authorization attempt. */
export type AuthorizationAttemptEvent =
  /** Something the surface should show the human. */
  | { readonly type: 'notice'; readonly notice: AuthorizationNoticeView }
  /** A question the human must answer through {@link AuthorizationAnswer}. */
  | { readonly type: 'prompt'; readonly prompt: AuthorizationPromptView }
  /**
   * The flow withdrew a question it no longer needs, because a browser
   * callback won the race against a typed code. The surface closes that
   * question without ending the attempt.
   */
  | { readonly type: 'prompt-withdrawn'; readonly promptId: string }
  /** The attempt finished; the stream ends after this frame. */
  | { readonly type: 'settled'; readonly status: 'authorized' | 'cancelled' }

/** One answer to a running attempt's question, sent back on its stream. */
export interface AuthorizationAnswer {
  /** The `id` of the prompt being answered. */
  readonly promptId: string
  /** Typed text, or the chosen option's `id`. */
  readonly value: string
}
