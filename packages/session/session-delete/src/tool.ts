/** Model-facing deletion with a one-call human approval requirement. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SessionDeleteRequest, SessionDeleteResult } from './types.ts'

/**
 * Register the optional deletion tool; its registration follows the plugin lifetime.
 * @param ctx - Context injecting tools and approval.
 * @param remove - The owning service's deletion operation.
 */
export function registerDeleteTool(ctx: Context, remove: (request: SessionDeleteRequest) => Promise<SessionDeleteResult>): void {
  ctx.tools.register(defineTool({
    name: 'session_delete',
    description: 'Permanently delete one session after human approval, stopping it first if loaded or running. This cannot be undone. The calling session, sessions with reminders, and sessions with subagent or lineage references cannot be deleted.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'Exact stored session id to permanently delete.' },
      confirmed: { type: 'boolean', required: true, description: 'Set true only when the user has requested permanent deletion of this exact session. A separate approval is still required for this call.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const sessionId = SessionId(args.session_id)
      if (!args.confirmed || exec.agent === undefined) {
        return JSON.stringify({ sessionId, code: 'confirmation-required' })
      }
      if (exec.agent.session.id === sessionId) return JSON.stringify({ sessionId, code: 'in-use' })
      const outcome = await ctx.approval.request({
        agent: exec.agent,
        toolName: 'session_delete',
        callId: exec.callId,
        reason: `Permanently delete session "${sessionId}", stopping it first if loaded or running. This cannot be undone.`,
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') return JSON.stringify({ sessionId, code: 'confirmation-required' })
      exec.signal.throwIfAborted()
      return JSON.stringify(await remove({ sessionId, confirmed: true }))
    },
    presentCall: args => ({ card: 'generic', title: 'Delete stored session', kind: 'other', rawInput: args }),
  }))
}
