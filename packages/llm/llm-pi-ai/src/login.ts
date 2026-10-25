/**
 * Authorization flows for the pi-ai providers that ship a login. This is the
 * whole of the translation between the harness's neutral notice/prompt
 * vocabulary and pi-ai's `AuthInteraction`; nothing above it knows which
 * library ran the conversation.
 *
 * @module dsh-llm-pi-ai/login
 */

import { randomUUID } from 'node:crypto'
import type { AuthEvent, AuthPrompt, AuthType, LoginOptions, Provider } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationMethod, AuthorizationPrompt, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { catalogProvider, catalogProviderIds } from './catalog.ts'
import { recordKeyFor } from './auth.ts'
import type { PiAiAuthInjection } from './adapter.ts'
import { createModels } from './models.ts'

/**
 * Record scope of the installation ids some OAuth logins send to their issuer.
 * It is deliberately not {@link RECORD_SCOPE}: that scope is addressed by
 * route keys, and a hand-declared route may take any lowercase hyphenated id,
 * so an installation record inside it could be read as a route's credential.
 */
export const INSTALLATION_SCOPE = 'llm-pi-ai-installation'

/**
 * The record holding the installation id presented to one provider. One id per
 * provider keeps two issuers from correlating the same installation.
 * @param providerId - the catalog provider the id is sent to.
 * @returns the installation record's key.
 */
export function installationKeyFor(providerId: string): CredentialKey {
  return credentialKey(INSTALLATION_SCOPE, providerId)
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The UUID one installation record holds, or undefined for an absent or foreign payload. */
function installationIdOf(record: CredentialRecord | undefined): string | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || !('id' in payload)) return undefined
  const id = payload.id
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id : undefined
}

/**
 * Read or mint the stable installation id one provider's login asks for.
 *
 * pi-ai's Sign in with ChatGPT (`openai`) identifies the app installation to
 * OpenAI through `LoginOptions.getDeviceId` and refuses to start without one;
 * OpenAI expects the same value on every later login. The id is a random UUID
 * stored in the harness credential store, so it survives restarts, follows
 * `$DSH_HOME`, and is minted under the store's cross-process lock. It is never
 * the harness anonymous user id, which other issuers already receive.
 * @param ctx - the plugin context carrying `ctx.credentials`.
 * @param providerId - the provider the id is presented to.
 * @returns the persisted UUID.
 * @throws {LlmError} code `NO_CREDENTIAL_STORE` without a credential service.
 */
export async function installationId(ctx: Context, providerId: string): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new LlmError(
      'llm-pi-ai: this composition mounts no credentials service, so the installation id a sign-in sends to'
      + ` "${providerId}" cannot be kept stable; mount one (dsh-credentials-local) to sign in`,
      'NO_CREDENTIAL_STORE',
    )
  }
  const stored = await credentials.modifyRecord(installationKeyFor(providerId), current =>
    Promise.resolve(installationIdOf(current) === undefined
      ? { kind: 'grant', payload: { id: randomUUID() } }
      : undefined))
  const id = installationIdOf(stored)
  /* v8 ignore next 3 -- the mutation above stores a valid id whenever the current one is not */
  if (id === undefined) {
    throw new LlmError(`llm-pi-ai: the installation id for "${providerId}" could not be stored`, 'NO_CREDENTIAL_STORE')
  }
  return id
}

/**
 * The login methods one catalog provider offers.
 *
 * A method appears only when pi-ai can actually run it: `oauth` carries a
 * `login` whose only app-supplied option is the installation id
 * {@link installationId} provides, while an api-key method has one only
 * when the provider collects its key interactively — which every installed one
 * currently does, so a key is typed into pi-ai's own prompt rather than into
 * the settings form.
 * @param provider - the installed catalog provider, if pi-ai ships one.
 * @returns its methods, most preferred first; empty when it offers no login.
 */
function loginMethods(provider: Provider | undefined): AuthorizationMethod[] {
  const methods: AuthorizationMethod[] = []
  const oauth = provider?.auth.oauth
  if (oauth !== undefined) methods.push({ id: 'oauth', label: oauth.loginLabel ?? oauth.name })
  const apiKey = provider?.auth.apiKey
  if (apiKey?.login !== undefined) methods.push({ id: 'api-key', label: apiKey.name })
  return methods
}

/**
 * Restate one pi-ai login event in the seam's vocabulary.
 *
 * A device-code grant is the one event carrying two things the human needs at
 * once — where to go and what to type there — which is why the neutral notice
 * has a `code` beside its `url` rather than folding the code into the message.
 * @param event - what pi-ai reported.
 * @param session - the attempt to report it to.
 */
function relay(event: AuthEvent, session: AuthorizationSession): void {
  switch (event.type) {
    case 'info': {
      const link = event.links?.[0]
      session.notify({ message: event.message, ...link === undefined ? {} : { url: link.url } })
      return
    }
    case 'auth_url':
      session.notify({
        message: event.instructions ?? 'Open this page to continue signing in.',
        url: event.url,
      })
      return
    case 'device_code':
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: event.verificationUri,
        code: event.userCode,
      })
      return
    case 'progress':
      session.notify({ message: event.message })
      return
    default:
      // pi-ai's event union is open to new members: a build that meets one it
      // does not know still shows the human that something is happening rather
      // than going silent mid-login.
      session.notify({ message: 'Signing in…' })
  }
}

/**
 * Restate one pi-ai prompt in the seam's vocabulary.
 *
 * `manual_code` becomes a plain text question because the difference pi-ai
 * draws — a code the human copies from a browser rather than a value they know
 * — changes nothing a surface renders. Its own `signal` is carried through, and
 * that is the part which matters: it is how a flow racing a typed code against
 * a browser callback withdraws the losing question.
 * @param prompt - what pi-ai asked.
 * @returns the neutral prompt to put to the human.
 */
function restate(prompt: AuthPrompt): AuthorizationPrompt {
  const signal = prompt.signal === undefined ? {} : { signal: prompt.signal }
  switch (prompt.type) {
    case 'select':
      return { ...signal, kind: 'select', message: prompt.message, options: prompt.options }
    case 'secret':
      return {
        ...signal,
        kind: 'secret',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    default:
      return {
        ...signal,
        kind: 'text',
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
  }
}

/**
 * Register one authorization flow per installed provider that ships a login.
 *
 * Registration is unconditional on configuration: a provider has to be signed
 * into before a route for it is worth adding, so the flow exists from the
 * moment the plugin mounts rather than appearing once a profile does.
 * @param ctx - the plugin context carrying `ctx.authorization`.
 * @param auth - the injectables every collection here is built with.
 */
export function registerPiAiFlows(ctx: Context, auth: PiAiAuthInjection): void {
  for (const providerId of catalogProviderIds()) {
    const provider = catalogProvider(providerId)
    const [first, ...rest] = loginMethods(provider)
    /* v8 ignore next 3 -- every id here names an installed provider and every
       installed provider ships a login, so no entry is skipped; the guard
       is what keeps that from becoming a crash if either stops being true. */
    if (provider === undefined || first === undefined) continue
    /* v8 ignore next 7 -- every installed catalog id is a lowercase
       hyphenated identifier; the guard keeps a future upstream id outside the
       record grammar (dotted or uppercase, as vendor ids elsewhere already
       are) from throwing in `recordKeyFor` and failing the whole mount. */
    if (!isCredentialKeySegment(providerId)) {
      ctx.logger.warn(
        'llm-pi-ai: catalog provider "%s" cannot address a credential record; its sign-in is not offered',
        providerId)
      continue
    }
    ctx.authorization.registerFlow({
      key: recordKeyFor(providerId),
      label: provider.name,
      methods: [first, ...rest],
      async run(session) {
        // A collection of its own, holding only the provider being signed
        // into: login is not serving requests, and the credential it produces
        // lands in the shared store either way.
        const models = createModels(auth)
        models.setProvider(provider)
        // Total over the two ids declared above, and the seam only ever hands
        // back one a flow declared.
        const type: AuthType = session.method === 'oauth' ? 'oauth' : 'api_key'
        // pi-ai reads the installation id synchronously, so it is resolved
        // before an OAuth login starts; a key login never needs it.
        const deviceId = type === 'oauth' ? await installationId(ctx, providerId) : undefined
        const options: LoginOptions = deviceId === undefined ? {} : { getDeviceId: () => deviceId }
        // pi-ai persists what the login returns through that same store, which
        // is what makes it the single writer of this record.
        await models.login(providerId, type, {
          signal: session.signal,
          notify: (event) => { relay(event, session) },
          prompt: prompt => session.prompt(restate(prompt)),
        }, options)
      },
    })
  }
}
