/** Opt-in deletion of stored Sessions through their lifecycle owner; no dependent resources are removed. */
import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError, SessionDeletionConflictError, SessionFormatUnsupportedError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-subagent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { registerDeleteTool } from './tool.ts'
import type { SessionDeleteRequest, SessionDeleteResult } from './types.ts'

export type { SessionDeleteRequest, SessionDeleteResult } from './types.ts'

type Inspection = SessionDeleteResult | { readonly snapshot: SessionPersistenceSnapshot | undefined }

function referencesRelatedSession(event: SessionEvent): boolean {
  return event.type === 'subagent/catalog' || event.type === 'subagent/descriptor'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Permanent Session deletion with lifecycle ownership and conservative dependency checks. */
    sessionDelete: SessionDeleteService
  }
}

/** Shared human and model deletion policy, backed by lifecycle exclusion and persistence ownership. */
export class SessionDeleteService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'schedule']

  private readonly dependencies: Promise<ProjectionHandle<boolean>>

  constructor(ctx: Context) {
    super(ctx, 'sessionDelete')
    this.dependencies = ctx.sessionProjections.register({
      key: 'sessionDeleteDependencies', stateVersion: 1, stateSchema: z.boolean(),
      init: () => false,
      apply: (related, event) => related || referencesRelatedSession(event),
    })
    ctx.inject(['tools', 'approval'], (scope) => { registerDeleteTool(scope, request => this.delete(request)) })
  }

  async [Service.init](): Promise<void> {
    await this.dependencies
  }

  /**
   * Permanently remove one Session, stopping a loaded Agent through its creator first.
   * Confirmed callers own human confirmation; the model tool separately requires approval.
   * Initial policy refusals do not stop the Agent. Dependencies appearing during shutdown
   * preserve storage but may leave the Agent stopped. A failed result means shutdown or
   * deletion could not be verified; refresh the listing before retrying. No dependent
   * resources are deleted, and activation remains excluded until deletion settles.
   * @param request - Exact Session identity and explicit human confirmation.
   * @returns Committed deletion, absence, a policy refusal, or an unverified failure.
   */
  @Remote({ name: 'delete', resources: { session: request => request.sessionId } })
  async delete(request: SessionDeleteRequest): Promise<SessionDeleteResult> {
    const { sessionId } = request
    if (!request.confirmed) return { sessionId, code: 'confirmation-required' }
    try {
      // Installed same-version Hosts may predate creator-authorized release support.
      if (typeof this.ctx.agents.withSessionRelease !== 'function') {
        if (this.ctx.sessions.get(sessionId) !== undefined) return { sessionId, code: 'in-use' }
        const before = await this.inspectTarget(sessionId)
        if ('code' in before) return before
        return await this.deleteReleased(sessionId, false)
      }
      const exclusive = await this.ctx.agents.withSessionRelease(sessionId, async (release): Promise<SessionDeleteResult> => {
        const attached = this.ctx.sessions.get(sessionId)
        const before = await this.inspectTarget(sessionId, attached)
        if ('code' in before) return before
        const reminders = await this.ctx.schedule.catalog()
        if (reminders.some(row => row.sessionId === sessionId)) return { sessionId, code: 'scheduled' }
        // Shutdown can await a schedule tool; never hold the Schedule FIFO while releasing.
        if (!await release()) return { sessionId, code: 'in-use' }
        return this.deleteReleased(sessionId, attached !== undefined)
      })
      return exclusive.allowed ? exclusive.value : { sessionId, code: 'in-use' }
    } catch (error) {
      if (error instanceof SessionAlreadyOwnedError || error instanceof SessionDeletionConflictError) return { sessionId, code: 'in-use' }
      if (error instanceof SessionPersistenceNotFoundError) return { sessionId, code: 'not-found' }
      if (error instanceof SessionFormatUnsupportedError) return { sessionId, code: 'unsupported' }
      this.ctx.logger.warn(`Session deletion failed for "${sessionId}"; refresh stored sessions before retrying.`, error)
      return { sessionId, code: 'failed', message: 'Deletion could not be verified. Refresh stored sessions before retrying.' }
    }
  }

  /** Delete only after shutdown, with the Schedule queue excluding new reminder rows. */
  private async deleteReleased(sessionId: SessionId, wasAttached: boolean): Promise<SessionDeleteResult> {
    const guarded = await this.ctx.schedule.withSessionDeletionGuard(sessionId, async (): Promise<SessionDeleteResult> => {
      if (this.ctx.sessions.get(sessionId) !== undefined) return { sessionId, code: 'in-use' }
      const after = await this.inspectTarget(sessionId)
      if ('code' in after) {
        if (after.code === 'not-found' && wasAttached) return { sessionId, code: 'deleted' }
        return after
      }
      const deleted = await this.ctx.sessionPersistence.delete(sessionId, { ifRevision: after.snapshot.revision })
      return { sessionId, code: deleted ? 'deleted' : 'not-found' }
    })
    return guarded.allowed ? guarded.value : { sessionId, code: 'scheduled' }
  }

  /** Inspect live state before shutdown, or the final durable state after release. */
  private inspectTarget(sessionId: SessionId): Promise<SessionDeleteResult | { readonly snapshot: SessionPersistenceSnapshot }>
  private inspectTarget(sessionId: SessionId, live: Session | undefined): Promise<Inspection>
  private async inspectTarget(sessionId: SessionId, live?: Session): Promise<Inspection> {
    const snapshot = await this.ctx.sessionPersistence.stat(sessionId)
    const header = live === undefined ? snapshot?.header : live.header
    if (header === undefined) return { sessionId, code: 'not-found' }
    if (header.origin === 'subagent' || header.parentSession !== undefined || header.isSeeded
      || (header.delegationDepth !== undefined && header.delegationDepth > 0)) {
      return { sessionId, code: 'related-session' }
    }
    const stored = await this.ctx.sessionPersistence.list()
    if (stored.some(row => row.header.parentSession === sessionId)) return { sessionId, code: 'related-session' }
    if (live !== undefined) {
      if ((await this.dependencies).stateOf(live)) {
        return { sessionId, code: 'related-session' }
      }
    } else {
      const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
      try {
        const { events } = await handle.read()
        if (events.some(referencesRelatedSession)) {
          return { sessionId, code: 'related-session' }
        }
      } finally { await handle.close() }
    }
    return { snapshot }
  }
}

export default SessionDeleteService
