/**
 * One provider card's sign-in controls: every method its pi-ai flow offers,
 * the attempt dialog that carries that flow's notices and questions, and the
 * signed-in state with its sign-out action.
 *
 * The card is contributed into the Models page's provider-card seat, so it
 * renders on saved rows, first-run setup cards, and the add-provider draft
 * alike. It knows nothing about a specific provider: it selects the flow whose
 * scope is the card's settings namespace and whose id is the route.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-models/ProviderSignIn
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AuthorizationFlowView, AuthorizationMethodView, AuthorizationNoticeView, AuthorizationPromptView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SignInOutcome, SignInState, SignInSurface } from './sign-in.ts'
import styles from './ProviderSignIn.module.css'
import type {} from './slot-contract.ts'
import type { en } from './locales.ts'

/** Injected dependencies of the provider-card sign-in occupant. */
export interface ProviderSignInInjected {
  hooks: {
    /** The shared flow listing bound by the UI renderer as `useFlows`. */
    flows: SnapshotStore<SignInState>
  }
  /** Run one flow method against the card's surface. */
  startSignIn: (key: string, method: string, surface: SignInSurface, signal: AbortSignal) => Promise<SignInOutcome>
  /** Remove the record a sign-in wrote. */
  signOut: (key: string) => Promise<string | undefined>
}

/** The share members this card reads: its row, its copy, and its Host callbacks. */
export type ProviderSignInProps =
  & Pick<PropsRuntime<'settings.models.provider-card'>, 'provider' | 'keyConfigured'>
  & Pick<PropsLocale<'settings.models'>, 't'>
  & Pick<InjectFace<ProviderSignInInjected>, 'useFlows' | 'startSignIn' | 'signOut'>

/** One question the dialog is putting to the human, with its answer channel. */
interface OpenPrompt {
  readonly prompt: AuthorizationPromptView
  readonly resolve: (value: string) => void
  readonly reject: (reason: Error) => void
}

/**
 * Render the sign-in state and actions for one provider row.
 * @param props - the directory row, the shared flow listing, and Host callbacks.
 * @returns the controls, or null when this route has no registered flow.
 */
export function ProviderSignIn({ provider, keyConfigured, useFlows, startSignIn, signOut, t }: ProviderSignInProps): ReactNode {
  const state = useFlows(snapshot => snapshot)
  const [method, setMethod] = useState<AuthorizationMethodView | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [signingOut, setSigningOut] = useState(false)
  const flow = state.flows.find(candidate =>
    candidate.scope === provider.settingsNs && candidate.id === provider.provider)
  if (flow === undefined) return null
  if (state.error !== null) return null
  // The key field is the direct API-key path; its method is only an alternative
  // while no key is configured, and a subscription method is always worth
  // offering.
  const methods = flow.methods.filter(candidate => candidate.id === 'oauth' || !keyConfigured)
  if (!flow.authorized && methods.length === 0) return null

  const remove = (): void => {
    setFailure(undefined)
    setSigningOut(true)
    void signOut(flow.key).then(
      (refused) => { setSigningOut(false); if (refused !== undefined) setFailure(refused) },
      (error: unknown) => {
        setSigningOut(false)
        setFailure(error instanceof Error ? error.message : String(error))
      },
    )
  }

  return (
    <div className={styles['signIn']}>
      {flow.authorized
        ? (
          <div className={styles['statusRow']}>
            <span className={styles['status']}>
              <span className={styles['statusDot']} aria-hidden="true" />
              {t(flow.credentialKind === 'api-key' ? 'credentialStored' : 'signedIn')}
            </span>
            <Button size="sm" variant="ghost" disabled={signingOut} onClick={remove}>
              {t('signOut')}
            </Button>
          </div>
        )
        : (
          <div className={styles['methods']}>
            {methods.map(candidate => (
              <Button
                key={candidate.id}
                size="sm"
                variant={candidate.id === 'oauth' ? 'outline' : 'ghost'}
                disabled={flow.inFlight}
                onClick={() => { setFailure(undefined); setMethod(candidate) }}
              >
                {candidate.id === 'oauth' ? candidate.label : t('signInWithKey')}
              </Button>
            ))}
          </div>
        )}
      {failure === undefined ? null : <p className={styles['failure']} role="alert">{failure}</p>}
      {method === undefined
        ? null
        : (
          <SignInDialog
            provider={provider.displayName}
            flow={flow}
            method={method}
            startSignIn={startSignIn}
            t={t}
            onClose={() => { setMethod(undefined) }}
          />
        )}
    </div>
  )
}

/** One running sign-in dialog, remounted for each attempt a human starts. */
function SignInDialog({ provider, flow, method, startSignIn, t, onClose }: {
  provider: string
  flow: AuthorizationFlowView
  method: AuthorizationMethodView
  startSignIn: ProviderSignInInjected['startSignIn']
  t: (key: keyof typeof en) => string
  onClose: () => void
}): ReactNode {
  const [notice, setNotice] = useState<AuthorizationNoticeView | undefined>(undefined)
  const [prompts, setPrompts] = useState<readonly OpenPrompt[]>([])
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const waiters = useRef(new Map<string, OpenPrompt>())
  const input = useRef<HTMLInputElement | null>(null)
  const closeRef = useRef(onClose)
  const startRef = useRef(startSignIn)
  closeRef.current = onClose
  startRef.current = startSignIn
  const open = prompts[0]

  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    const surface: SignInSurface = {
      notice: (next) => { if (!cancelled) setNotice(next) },
      prompt: prompt => new Promise<string>((resolve, reject) => {
        const entry = { prompt, resolve, reject }
        waiters.current.set(prompt.id, entry)
        if (!cancelled) setPrompts(current => [...current, entry])
      }),
      withdrawPrompt: (promptId) => {
        const entry = waiters.current.get(promptId)
        if (entry === undefined) return
        waiters.current.delete(promptId)
        entry.reject(new Error('the sign-in question was withdrawn'))
        /* v8 ignore next -- closing the dialog rejects and clears this waiter before any later withdrawal can find it */
        if (!cancelled) setPrompts(current => current.filter(candidate => candidate.prompt.id !== promptId))
      },
      dismiss: () => {
        for (const entry of waiters.current.values()) entry.reject(new Error('the sign-in attempt ended'))
        waiters.current.clear()
        /* v8 ignore next -- settle-after-close reaches this only after the unmounted dialog has nothing to clear */
        if (!cancelled) setPrompts([])
      },
    }
    // Deferred one task so a StrictMode probe that mounts, cleans up, and
    // remounts never claims the seam's one-attempt-per-record slot.
    const timer = window.setTimeout(() => {
      /* v8 ignore next -- the cleanup below always clears this timer before it can fire */
      if (cancelled) return
      void startRef.current(flow.key, method.id, surface, abort.signal).then((outcome) => {
        if (cancelled) return
        if (outcome.kind === 'failed') setFailure(outcome.message)
        else closeRef.current()
      }, (error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error))
      })
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      abort.abort()
    }
  }, [attempt, flow.key, method.id])

  useEffect(() => {
    if (open?.prompt.kind === 'select') return
    input.current?.focus()
  }, [open?.prompt.id, open?.prompt.kind])

  const answer = (value: string): void => {
    /* v8 ignore next -- only a mounted question renders the controls that answer it */
    if (open === undefined) return
    waiters.current.delete(open.prompt.id)
    setPrompts(current => current.filter(candidate => candidate.prompt.id !== open.prompt.id))
    setDraft('')
    open.resolve(value)
  }

  const retry = (): void => {
    setFailure(undefined)
    setNotice(undefined)
    setPrompts([])
    setDraft('')
    setAttempt(current => current + 1)
  }

  const close = (): void => {
    for (const entry of waiters.current.values()) entry.reject(new Error('the sign-in dialog was closed'))
    waiters.current.clear()
    onClose()
  }

  return (
    <Modal
      open
      title={t('signInProvider').replace('{provider}', () => provider)}
      closeLabel={t('close')}
      onClose={close}
      footer={(
        <div className={styles['dialogActions']}>
          <Button size="sm" variant="outline" onClick={close}>{t('cancel')}</Button>
          {failure !== undefined
            ? <Button size="sm" variant="primary" onClick={retry}>{t('signInRetry')}</Button>
            : open === undefined || open.prompt.kind === 'select'
              ? null
              : <Button size="sm" variant="primary" disabled={draft.length === 0} onClick={() => { answer(draft) }}>{t('signInContinue')}</Button>}
        </div>
      )}
    >
      <div className={styles['dialogBody']}>
        {notice === undefined ? null : (
          <div className={styles['notice']}>
            <p className={styles['noticeMessage']}>{notice.message}</p>
            {notice.url === undefined ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const url = notice.url
                  /* v8 ignore next -- narrowed by the conditional above */
                  if (url !== undefined) window.open(url, '_blank', 'noopener,noreferrer')
                }}
              >
                {t('signInOpenPage')}
              </Button>
            )}
            {notice.code === undefined ? null : (
              <p className={styles['code']}>
                <span className={styles['codeLabel']}>{t('signInCode')}</span>
                <code className={styles['codeValue']}>{notice.code}</code>
              </p>
            )}
          </div>
        )}
        {failure === undefined ? null : <p className={styles['failure']} role="alert">{failure}</p>}
        {failure !== undefined
          ? null
          : open === undefined
            ? <p className={styles['running']} role="status">{t('signInRunning')}</p>
            : (
              <div className={styles['question']}>
                <p className={styles['questionMessage']}>{open.prompt.message}</p>
                {open.prompt.kind === 'select'
                  ? (
                    <div className={styles['options']} role="radiogroup" aria-label={open.prompt.message}>
                      {open.prompt.options.map((option, index) => (
                        <Button
                          key={option.id}
                          size="sm"
                          variant="outline"
                          data-modal-autofocus={index === 0 ? true : undefined}
                          onClick={() => { answer(option.id) }}
                        >
                          <span className={styles['option']}>
                            <span>{option.label}</span>
                            {option.description === undefined
                              ? null
                              : <span className={styles['optionDescription']}>{option.description}</span>}
                          </span>
                        </Button>
                      ))}
                    </div>
                  )
                  : (
                    <input
                      ref={input}
                      className={styles['input']}
                      type={open.prompt.kind === 'secret' ? 'password' : 'text'}
                      value={draft}
                      placeholder={open.prompt.placeholder ?? t('signInTextPrompt')}
                      aria-label={open.prompt.message}
                      autoComplete="off"
                      onChange={(event) => { setDraft(event.target.value) }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          answer(draft)
                        }
                      }}
                    />
                  )}
              </div>
            )}
      </div>
    </Modal>
  )
}
