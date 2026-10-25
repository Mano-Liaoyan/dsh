// @vitest-environment jsdom
/** Provider-card sign-in controls: methods, notices, questions, settlement, and sign-out. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { AuthorizationFlowView } from '@deepseek-ai/dsh-api-remotes/client'
import { ProviderSignIn } from '../src/client/ProviderSignIn.tsx'
import type { ProviderSignInProps } from '../src/client/ProviderSignIn.tsx'
import type { SignInOutcome, SignInState, SignInSurface } from '../src/client/sign-in.ts'
import type { ProviderDirectoryEntry } from '../src/client/store.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: keyof typeof en) => en[key]) as ProviderSignInProps['t']

const PROVIDER: ProviderDirectoryEntry = {
  provider: 'anthropic',
  displayName: 'Anthropic',
  settingsNs: 'llm-pi-ai',
  settingsPath: ['providers', 'anthropic'],
  active: true,
}

const FLOW: AuthorizationFlowView = {
  key: 'llm-pi-ai/anthropic',
  scope: 'llm-pi-ai',
  id: 'anthropic',
  label: 'Anthropic',
  methods: [{ id: 'oauth', label: 'Sign in with Test' }, { id: 'api-key', label: 'API key' }],
  inFlight: false,
  authorized: false,
}

/** One mounted card over a real snapshot store and scripted Host callbacks. */
function mount(overrides: {
  flow?: AuthorizationFlowView | null
  status?: SignInState['status']
  error?: string | null
  start?: (key: string, method: string, surface: SignInSurface, signal: AbortSignal) => Promise<SignInOutcome>
  signOut?: (key: string) => Promise<string | undefined>
} = {}) {
  const state: SignInState = {
    status: overrides.status ?? 'ready',
    error: overrides.error ?? null,
    flows: overrides.flow === undefined ? [FLOW] : overrides.flow === null ? [] : [overrides.flow],
  }
  const store = createSnapshotStore<SignInState>(state)
  const startSignIn = vi.fn(overrides.start ?? (() => Promise.resolve({ kind: 'authorized' as const })))
  const signOut = vi.fn(overrides.signOut ?? (() => Promise.resolve(undefined)))
  const view = render(
    <ProviderSignIn
      provider={PROVIDER}
      keyConfigured={false}
      useFlows={bindSnapshotSelector(store)}
      startSignIn={startSignIn}
      signOut={signOut}
      t={t}
    />,
  )
  return { view, store, startSignIn, signOut }
}

/** Let the deferred attempt start and React settle. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
}

describe('provider sign-in card', () => {
  it('offers every method the flow declares and labels the key method itself', () => {
    mount()
    expect(screen.getByRole('button', { name: 'Sign in with Test' })).toBeTruthy()
    expect(screen.getByRole('button', { name: en.signInWithKey })).toBeTruthy()
  })

  it('hides the key method while the key field already holds a credential', () => {
    const store = createSnapshotStore<SignInState>({ status: 'ready', error: null, flows: [FLOW] })
    render(
      <ProviderSignIn
        provider={PROVIDER}
        keyConfigured
        useFlows={bindSnapshotSelector(store)}
        startSignIn={vi.fn(() => Promise.resolve<SignInOutcome>({ kind: 'cancelled' }))}
        signOut={vi.fn(() => Promise.resolve(undefined))}
        t={t}
      />,
    )
    expect(screen.getByRole('button', { name: 'Sign in with Test' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.signInWithKey })).toBeNull()
  })

  it('renders nothing for an unconfigured key-only flow whose key is already stored', () => {
    const store = createSnapshotStore<SignInState>({
      status: 'ready',
      error: null,
      flows: [{ ...FLOW, methods: [{ id: 'api-key', label: 'API key' }] }],
    })
    const view = render(
      <ProviderSignIn
        provider={PROVIDER}
        keyConfigured
        useFlows={bindSnapshotSelector(store)}
        startSignIn={vi.fn(() => Promise.resolve<SignInOutcome>({ kind: 'cancelled' }))}
        signOut={vi.fn(() => Promise.resolve(undefined))}
        t={t}
      />,
    )
    expect(view.container.innerHTML).toBe('')
  })

  it('renders nothing when no flow owns the row, the listing failed, or the row is another family', () => {
    const missing = mount({ flow: null })
    expect(missing.view.container.innerHTML).toBe('')
    cleanup()
    const failed = mount({ error: 'listing failed' })
    expect(failed.view.container.innerHTML).toBe('')
    cleanup()
    const otherFamily = mount()
    otherFamily.view.rerender(
      <ProviderSignIn
        provider={{ ...PROVIDER, settingsNs: 'llm-deepseek' }}
        keyConfigured={false}
        useFlows={bindSnapshotSelector(otherFamily.store)}
        startSignIn={otherFamily.startSignIn}
        signOut={otherFamily.signOut}
        t={t}
      />,
    )
    expect(otherFamily.view.container.innerHTML).toBe('')
  })

  it('carries a notice to the dialog and sends the typed answer back', async () => {
    const answers: string[] = []
    const { startSignIn } = mount({
      start: async (_key, _method, surface) => {
        surface.notice({ message: 'Open the page', url: 'https://example.test', code: 'ABC-123' })
        answers.push(await surface.prompt({
          id: 'prompt-1', kind: 'text', message: 'Paste the code', placeholder: 'ABC-',
        }))
        return { kind: 'authorized' }
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    const dialog = await screen.findByRole('dialog', { name: en.signInProvider.replace('{provider}', 'Anthropic') })
    await screen.findByText('Open the page')
    expect(screen.getByText('ABC-123')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Paste the code'), { target: { value: 'typed' } })
    fireEvent.click(screen.getByRole('button', { name: en.signInContinue }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(answers).toEqual(['typed'])
    expect(startSignIn).toHaveBeenCalledWith('llm-pi-ai/anthropic', 'oauth', expect.any(Object), expect.any(AbortSignal))
    expect(dialog).toBeTruthy()
  })

  it('masks a secret question and answers a select with the chosen option id', async () => {
    let secret: string | undefined
    let selected: string | undefined
    mount({
      start: async (_key, _method, surface) => {
        secret = await surface.prompt({ id: 'prompt-1', kind: 'secret', message: 'Paste the key' })
        selected = await surface.prompt({
          id: 'prompt-2', kind: 'select', message: 'Which account?', options: [
            { id: 'work', label: 'Work' },
            { id: 'home', label: 'Home', description: 'Personal' },
          ],
        })
        return { kind: 'cancelled' }
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    const secretInput = await screen.findByLabelText('Paste the key')
    expect(secretInput.getAttribute('type')).toBe('password')
    fireEvent.change(secretInput, { target: { value: 'sk-typed' } })
    fireEvent.click(screen.getByRole('button', { name: en.signInContinue }))
    await screen.findByRole('button', { name: /Work/u })
    expect(screen.getByText('Personal')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Work/u }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(secret).toBe('sk-typed')
    expect(selected).toBe('work')
  })

  it('closes a question its flow withdrew and keeps the attempt running', async () => {
    let withdraw: (() => void) | undefined
    let finish: (() => void) | undefined
    mount({
      start: (_key, _method, surface) => new Promise<SignInOutcome>((resolve) => {
        void surface.prompt({ id: 'prompt-1', kind: 'text', message: 'Paste the code' }).catch(() => { /* withdrawn */ })
        withdraw = () => { surface.withdrawPrompt('prompt-1') }
        finish = () => { resolve({ kind: 'cancelled' }) }
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    await screen.findByLabelText('Paste the code')
    act(() => { withdraw?.() })
    await waitFor(() => { expect(screen.queryByLabelText('Paste the code')).toBeNull() })
    expect(screen.getByRole('status').textContent).toBe(en.signInRunning)
    act(() => { finish?.() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('shows a failed attempt and retries it on request', async () => {
    const start = vi.fn(() => Promise.resolve<SignInOutcome>({ kind: 'failed', message: 'the provider refused' }))
    mount({ start })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    expect((await screen.findByRole('alert')).textContent).toBe('the provider refused')
    fireEvent.click(screen.getByRole('button', { name: en.signInRetry }))
    await waitFor(() => { expect(start).toHaveBeenCalledTimes(2) })
    await screen.findByRole('alert')
  })

  it('withdraws the attempt when the dialog is cancelled', async () => {
    let seen: AbortSignal | undefined
    mount({
      start: (_key, _method, _surface, signal) => {
        seen = signal
        return new Promise<SignInOutcome>(() => { /* held until the dialog closes */ })
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    await screen.findByRole('dialog')
    await settle()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(seen?.aborted).toBe(true) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows signed-in state and reports a refused sign-out', async () => {
    mount({
      flow: { ...FLOW, authorized: true, credentialKind: 'grant' },
      signOut: () => Promise.resolve('the store refused'),
    })
    expect(screen.getByText(en.signedIn)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect((await screen.findByRole('alert')).textContent).toBe('the store refused')
  })

  it('labels a stored key record as a saved credential rather than an account sign-in', () => {
    mount({ flow: { ...FLOW, authorized: true, credentialKind: 'api-key' } })
    expect(screen.getByText(en.credentialStored)).toBeTruthy()
    expect(screen.queryByText(en.signedIn)).toBeNull()
  })
})

describe('provider sign-in dialog details', () => {
  it('clears a sign-out refusal and handles a rejected sign-out', async () => {
    const success = mount({ flow: { ...FLOW, authorized: true, credentialKind: 'grant' } })
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.signOut })).toBeTruthy() })
    expect(screen.queryByRole('alert')).toBeNull()
    success.view.unmount()
    cleanup()

    const rejected = mount({
      flow: { ...FLOW, authorized: true, credentialKind: 'grant' },
      signOut: () => Promise.reject(new Error('the store rejected')),
    })
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect((await screen.findByRole('alert')).textContent).toBe('the store rejected')
    rejected.view.unmount()
    cleanup()

    mount({
      flow: { ...FLOW, authorized: true, credentialKind: 'grant' },
      signOut: async () => { throw { toString: () => 'literal refusal' } },
    })
    fireEvent.click(screen.getByRole('button', { name: en.signOut }))
    expect((await screen.findByRole('alert')).textContent).toBe('literal refusal')
  })

  it('renders a notice without a page or code and opens the page it does name', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    let stage = 0
    mount({
      start: async (_key, _method, surface) => {
        stage += 1
        surface.notice({ message: 'Plain message' })
        if (stage === 1) {
          await surface.prompt({ id: 'prompt-1', kind: 'text', message: 'Continue' })
          return { kind: 'cancelled' }
        }
        return { kind: 'cancelled' }
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    await screen.findByText('Plain message')
    expect(screen.queryByRole('button', { name: en.signInOpenPage })).toBeNull()
    expect(screen.queryByText(en.signInCode)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    open.mockRestore()
  })

  it('opens the named sign-in page', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    mount({
      start: (_key, _method, surface) => new Promise<SignInOutcome>(() => {
        surface.notice({ message: 'Open the page', url: 'https://example.test/start' })
      }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    fireEvent.click(await screen.findByRole('button', { name: en.signInOpenPage }))
    expect(open).toHaveBeenCalledWith('https://example.test/start', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('answers a typed question with Enter', async () => {
    let answer: string | undefined
    mount({
      start: async (_key, _method, surface) => {
        answer = await surface.prompt({ id: 'prompt-1', kind: 'text', message: 'Paste the code' })
        return { kind: 'authorized' }
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    const input = await screen.findByLabelText('Paste the code')
    fireEvent.change(input, { target: { value: 'via-enter' } })
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(answer).toBe('via-enter')
  })

  it('dismisses an open question and ignores reports after the dialog closed', async () => {
    let surface: SignInSurface | undefined
    let finish: (() => void) | undefined
    mount({
      start: (_key, _method, attempt) => {
        surface = attempt
        void attempt.prompt({ id: 'prompt-1', kind: 'text', message: 'Paste the code' }).catch(() => { /* dismissed */ })
        return new Promise<SignInOutcome>((resolve) => { finish = () => { resolve({ kind: 'cancelled' }) } })
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    await screen.findByLabelText('Paste the code')
    act(() => { surface?.withdrawPrompt('never-asked') })
    act(() => { surface?.dismiss() })
    await waitFor(() => { expect(screen.queryByLabelText('Paste the code')).toBeNull() })
    act(() => { finish?.() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    // A report after the card closed must not touch the unmounted dialog.
    act(() => {
      surface?.notice({ message: 'late' })
      void surface?.prompt({ id: 'prompt-2', kind: 'text', message: 'late' }).catch(() => { /* dismissed */ })
    })
  })

  it('reports a rejected attempt and its literal failure', async () => {
    mount({ start: () => Promise.reject(new Error('the attempt broke')) })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    expect((await screen.findByRole('alert')).textContent).toBe('the attempt broke')
    cleanup()

    mount({ start: async () => { throw { toString: () => 'literal attempt failure' } } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    expect((await screen.findByRole('alert')).textContent).toBe('literal attempt failure')
  })

  it('never starts an attempt for a card unmounted before its deferred start', async () => {
    const start = vi.fn(() => Promise.resolve<SignInOutcome>({ kind: 'cancelled' }))
    const { view } = mount({ start })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    view.unmount()
    await settle()
    expect(start).not.toHaveBeenCalled()
  })

  it('ignores a settlement that arrives after the dialog closed', async () => {
    const finish = Promise.withResolvers<SignInOutcome>()
    const start = vi.fn(() => finish.promise)
    mount({ start })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    await act(async () => { finish.resolve({ kind: 'authorized' }); await Promise.resolve() })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('closes a question still waiting when the dialog is cancelled', async () => {
    let rejected: unknown
    mount({
      start: (_key, _method, surface) => {
        void surface.prompt({ id: 'prompt-1', kind: 'text', message: 'Paste the code' })
          .catch((error: unknown) => { rejected = error })
        return new Promise<SignInOutcome>(() => { /* held */ })
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Test' }))
    await screen.findByLabelText('Paste the code')
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    await waitFor(() => { expect(rejected).toBeInstanceOf(Error) })
  })
})
