/** Opt-in permanent Session deletion through an existing menu extension and shell overlay. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-session-delete/remote'
import { DeleteSessionMenuItem, DeleteSessionOverlay } from './DeleteSession.tsx'
import { en, zh } from './locales.ts'
import { createSessionDeleteStore, type DeleteTarget } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Permanent Session deletion confirmation and outcome copy. */
    sessionDelete: keyof typeof en
  }
}

/** Services read by the plugin; slot ownership is awaited separately. */
export const inject = ['slots', 'locale', 'remote', 'remote.sessionDelete']

/**
 * Register opt-in deletion without optimistic catalog mutation or live Session teardown.
 * @param ctx - Browser plugin scope with the generated Session deletion remote.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('sessionDelete', { en, zh }))
  const store = createSessionDeleteStore()
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'session-delete', order: 500,
    locale: 'sessionDelete', store,
  }, DeleteSessionMenuItem))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'session-delete', locale: 'sessionDelete', store,
    inject: (actions) => {
      let pending = false
      const confirmDelete = async (target: DeleteTarget): Promise<void> => {
        if (pending) return
        pending = true
        actions.begin()
        try {
          const result = await ctx.remote.sessionDelete.delete({ sessionId: target.sessionId, confirmed: true })
          actions.settle(result.ok ? result.value.code : 'unavailable')
        } catch (error: unknown) {
          // A transport rejection cannot establish whether the Host committed deletion.
          console.warn('Session deletion outcome unavailable:', error)
          actions.settle('unavailable')
        } finally {
          pending = false
        }
      }
      return { confirmDelete: (target: DeleteTarget) => { void confirmDelete(target) } }
    },
  }, DeleteSessionOverlay))
}
