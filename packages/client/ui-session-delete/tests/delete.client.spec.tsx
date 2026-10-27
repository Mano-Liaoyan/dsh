// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { MenuOpenState } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionDeleteResult } from '@deepseek-ai/dsh-session-delete/types'
import { apply, inject } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'

usePinnedBrowserLanguages('en')
afterEach(cleanup)
const sessionId = 'inactive-session' as SessionId

type FrameProps = PropsRenderSlots<'sidebar.workspaces.session.menu.item' | 'shell.overlay'>
function Frame({ renderSlot }: FrameProps) {
  const menu: MenuOpenState = useState(true)
  return <>
    {menu[0] && renderSlot('sidebar.workspaces.session.menu.item', { sessionId, displayTitle: 'Saved work' }, { hookContext: menu })}
    {renderSlot('shell.overlay', {})}
  </>
}

type DeleteResponse = { ok: true; value: SessionDeleteResult } | { ok: false; error: { code: string; message: string } }

async function setup(run: () => Promise<DeleteResponse>) {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  const remove = vi.fn(run)
  runtime.remote.provideNamespaces({ sessionDelete: { delete: remove } })
  await runtime.root.declare({
    'sidebar.workspaces.session.menu.item': {
      kind: 'list', scope: 'root', inject: { hooks: {
        menuOpenState: (_standard, state: MenuOpenState) => () => state,
        shortcuts: createSnapshotStore([]),
      } },
    },
    'shell.overlay': { kind: 'list', scope: 'root' },
  }, Frame)
  const feature = await runtime.mount({ inject, apply })
  runtime.renderRoot()
  return { runtime, remove, feature, locale }
}

function openConfirmation() {
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete session' }))
  expect(screen.queryByRole('menuitem')).toBeNull()
  expect(screen.getByRole('dialog')).toBeTruthy()
}

describe('Session deletion confirmation', () => {
  it('survives menu closure and cancel never calls the Host', async () => {
    const { remove } = await setup(async () => ({ ok: true, value: { code: 'deleted', sessionId } }))
    openConfirmation()
    expect(screen.getByText(en.safety)).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toMatchInlineSnapshot('"Delete this session?Stop any running work in “Saved work” and permanently delete its saved conversation. This cannot be undone. Files in your workspace are not deleted.You can also delete the session currently on screen. Remove its scheduled tasks first.CancelDelete permanently"')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it('confirms exactly once, blocks repeated clicks and dismissal, and reports committed success', async () => {
    let resolve!: (result: { ok: true; value: SessionDeleteResult }) => void
    const completion = new Promise<{ ok: true; value: SessionDeleteResult }>((done) => { resolve = done })
    const { remove } = await setup(() => completion)
    openConfirmation()
    const confirm = screen.getByRole('button', { name: 'Delete permanently' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(remove).toHaveBeenCalledExactlyOnceWith({ sessionId, confirmed: true })
    await act(async () => { resolve({ ok: true, value: { code: 'deleted', sessionId } }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain(en['result.deleted'])
  })

  it.each(['not-found', 'in-use', 'confirmation-required', 'unsupported', 'scheduled', 'related-session', 'failed'] as const)(
    'reports the %s refusal without claiming success', async (code) => {
      await setup(async () => ({ ok: true, value: code === 'failed'
        ? { code, sessionId, message: 'Internal storage detail' } : { code, sessionId } }))
      openConfirmation()
      fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
      await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en[`result.${code}`]) })
      expect(screen.queryByText('Internal storage detail')).toBeNull()
      expect(screen.queryByRole('dialog')).toBeNull()
    },
  )

  it('reports uncertainty when the remote envelope fails', async () => {
    await setup(async () => ({ ok: false, error: { code: 'transport/disconnected', message: 'Private detail' } }))
    openConfirmation()
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en['result.unavailable']) })
    expect(screen.queryByText('Private detail')).toBeNull()
  })

  it('contains a rejected transport call and reports uncertainty', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warning.mockRestore() })
    await setup(async () => { throw new Error('Disconnected') })
    openConfirmation()
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain(en['result.unavailable']) })
  })

  it('uses Chinese copy and removes contributions when the plugin unloads', async () => {
    const { locale, feature, runtime } = await setup(async () => ({ ok: true, value: { code: 'deleted', sessionId } }))
    await act(async () => { locale.setLocale('zh') })
    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }))
    expect(screen.getByRole('button', { name: '永久删除' })).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('停止“Saved work”中正在进行的工作')
    expect(screen.getByRole('dialog').textContent).toContain('当前屏幕上显示的会话也可以删除')
    await feature.dispose()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(runtime.slots.entries('sidebar.workspaces.session.menu.item')).toHaveLength(0)
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
  })
})
