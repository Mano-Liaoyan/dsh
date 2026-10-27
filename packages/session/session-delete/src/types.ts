/** Browser-safe requests and outcomes for permanent stored-Session deletion. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Explicit authorization supplied by a human-facing caller. */
export interface SessionDeleteRequest {
  /** Stored Session to permanently remove. */
  readonly sessionId: SessionId
  /** True only after the caller obtains confirmation for this exact Session. */
  readonly confirmed: boolean
}

/**
 * Refusals preserve storage but may follow shutdown if dependencies raced cancellation.
 * Failed reports an unverified shutdown or deletion outcome.
 */
export type SessionDeleteResult =
  | { readonly code: 'deleted' | 'not-found' | 'in-use' | 'confirmation-required' | 'unsupported' | 'scheduled' | 'related-session'; readonly sessionId: SessionId }
  | { readonly code: 'failed'; readonly sessionId: SessionId; readonly message: string }
