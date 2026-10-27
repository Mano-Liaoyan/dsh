/** Interaction state shared by the Session row action and the shell overlay. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionDeleteResult } from '@deepseek-ai/dsh-session-delete/types'

/** Session selected for explicit, irreversible deletion. */
export interface DeleteTarget {
  sessionId: SessionId
  displayTitle: string
}

/** Only presentation state; Session catalog updates remain Host-owned. */
export interface DeleteState {
  target: DeleteTarget | null
  pending: boolean
  notice: { code: SessionDeleteResult['code'] | 'unavailable'; seq: number } | null
  sequence: number
}

type DeleteActions = {
  request: (draft: DeleteState, target: DeleteTarget) => void
  close: (draft: DeleteState) => void
  begin: (draft: DeleteState) => void
  settle: (draft: DeleteState, code: NonNullable<DeleteState['notice']>['code']) => void
  dismiss: (draft: DeleteState) => void
}

/**
 * Create one plugin-owned interaction store; repeated requests cannot replace an open confirmation.
 * @returns A handle shared by the menu and overlay registrations.
 */
export function createSessionDeleteStore(): EngineStoreHandle<DeleteState, DeleteActions> {
  return defineStore({
    init: (): DeleteState => ({ target: null, pending: false, notice: null, sequence: 0 }),
    actions: {
      request(draft: DeleteState, target: DeleteTarget) {
        if (draft.target !== null) return
        draft.target = target
      },
      close(draft: DeleteState) {
        if (!draft.pending) draft.target = null
      },
      begin(draft: DeleteState) { draft.pending = true },
      settle(draft: DeleteState, code: NonNullable<DeleteState['notice']>['code']) {
        draft.pending = false
        draft.target = null
        draft.notice = { code, seq: ++draft.sequence }
      },
      dismiss(draft: DeleteState) { draft.notice = null },
    },
  })
}
