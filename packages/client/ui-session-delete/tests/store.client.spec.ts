import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSessionDeleteStore } from '../src/client/store.ts'

const target = { sessionId: 'one' as SessionId, displayTitle: 'One' }

describe('Session deletion interaction store', () => {
  it('keeps one exact confirmation target and prevents pending dismissal', () => {
    const store = createSessionDeleteStore().create()
    store.actions.request(target)
    store.actions.request({ sessionId: 'two' as SessionId, displayTitle: 'Two' })
    expect(store.getSnapshot().target).toEqual(target)
    store.actions.begin()
    store.actions.close()
    expect(store.getSnapshot().target).toEqual(target)
    store.actions.settle('in-use')
    expect(store.getSnapshot()).toMatchObject({ target: null, pending: false, notice: { code: 'in-use', seq: 1 } })
    store.actions.dismiss()
    expect(store.getSnapshot().notice).toBeNull()
    store.actions.request(target)
    store.actions.close()
    expect(store.getSnapshot().target).toBeNull()
    store.actions.request(target)
    store.actions.begin()
    store.actions.settle('deleted')
    expect(store.getSnapshot().notice).toEqual({ code: 'deleted', seq: 2 })
  })

  it('isolates plugin instances', () => {
    const first = createSessionDeleteStore().create()
    const second = createSessionDeleteStore().create()
    first.actions.request(target)
    expect(second.getSnapshot().target).toBeNull()
  })
})
