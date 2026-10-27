/** Session deletion menu action and its menu-independent confirmation and outcome surfaces. */
import { Button, IconTrashOutlineRegular, IconWarningOutlineRegular, MenuItemButton, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createSessionDeleteStore, DeleteTarget } from './store.ts'
import type {} from './index.ts'

type StoreProps = PropsStore<ReturnType<typeof createSessionDeleteStore>>
type LocaleProps = PropsLocale<'sessionDelete'>
/** Callback that starts the Host operation only after explicit confirmation. */
export interface DeleteInjected {
  /** Start deletion for the open confirmation; repeated pending calls are ignored. */
  confirmDelete: (target: DeleteTarget) => void
}
/** Derived inputs for the existing Session row menu. */
export type DeleteMenuProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & StoreProps & LocaleProps
/** Derived inputs for the shell-owned operation surface. */
export type DeleteOverlayProps = PropsRuntime<'shell.overlay'> & StoreProps & LocaleProps & InjectFace<DeleteInjected>

/**
 * Open a confirmation outside the menu, without retaining or deleting the selected Session.
 * @param props - Row identity, menu controls, interaction store, and localized copy.
 * @returns A destructive menu item.
 */
export function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, useStore, actions, t }: DeleteMenuProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const busy = useStore(state => state.target !== null)
  return (
    <MenuItemButton danger separatorBefore disabled={busy} icon={<IconTrashOutlineRegular />} onSelect={() => {
      actions.request({ sessionId, displayTitle })
      setMenuOpen(false)
    }}>
      {t('delete')}
    </MenuItemButton>
  )
}

/**
 * Keep confirmation and outcome feedback mounted after the row menu closes; pending operations cannot be dismissed.
 * @param props - Shared presentation state and the confirmed Host callback.
 * @returns Confirmation, outcome Toast, or neither.
 */
export function DeleteSessionOverlay({ useStore, actions, confirmDelete, t }: DeleteOverlayProps) {
  const { target, pending, notice } = useStore(state => state)
  return <>
    {target !== null && <Modal
      open
      title={t('title')}
      description={t('description', { title: target.displayTitle })}
      closeLabel={t('close')}
      onClose={actions.close}
      footer={<>
        <Button variant="outline" disabled={pending} onClick={actions.close} data-modal-autofocus>{t('cancel')}</Button>
        <Button variant="primary" disabled={pending} onClick={() => { confirmDelete(target) }}>{t('confirm')}</Button>
      </>}
    >
      <p>{t('safety')}</p>
    </Modal>}
    {notice !== null && <Toast
      key={notice.seq}
      text={t(`result.${notice.code}`)}
      {...notice.code === 'deleted' ? { tone: 'success' as const } : {}}
      icon={<IconWarningOutlineRegular />}
      onDone={actions.dismiss}
    />}
  </>
}
