import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@convokitapp/react-native'
import { ComposerDraft } from '../src/composer-draft'

// The edit session of the default composer, driven the way the view drives it: `sync` mirrors the host's
// `editingMessage` during render, the handlers run from presses and the save result.
const message = (id: string, text: string | null, revision = 0): Message => ({
  id, conversationId: 'room', senderId: 'me', clientMessageId: null, text, media: text === null ? [{ type: 'image', url: `https://cdn/${id}` }] : [],
  createdAt: new Date('2026-08-01T11:19:00Z'), updatedAt: null, revision,
})
const draft = () => {
  const typing = vi.fn()
  const store = new ComposerDraft()
  store.onTyping = typing
  const listener = vi.fn()
  store.subscribe(listener)
  return { store, typing, listener }
}

describe('composer draft', () => {
  it('stashes the unsent draft and prefills the field silently when edit mode begins', () => {
    const { store, typing, listener } = draft()
    store.setValue('unsent')
    expect(listener).toHaveBeenCalledTimes(1)
    store.sync(message('m1', 'original'))
    expect(store.current).toBe('original')
    expect(store.editing).toMatchObject({ prefilled: 'original', stash: 'unsent', saving: false })
    expect(typing).not.toHaveBeenCalled()
    expect(listener).toHaveBeenCalledTimes(1)
    // A media message without a caption prefills an empty field.
    store.sync(message('m2', null))
    expect(store.current).toBe('')
    expect(store.editing?.stash).toBe('unsent')
    expect(typing).not.toHaveBeenCalled()
  })

  it('keeps the field on a same-id refresh (a conflict) and re-syncing the same snapshot', () => {
    const { store, typing } = draft()
    const original = message('m1', 'original')
    store.sync(original)
    store.setValue('mine')
    store.sync({ ...original, text: 'theirs', revision: 1 })
    expect(store.current).toBe('mine')
    expect(store.editing?.snapshot.text).toBe('theirs')
    store.sync(original)
    expect(store.current).toBe('mine')
    expect(typing).not.toHaveBeenCalled()
  })

  it('cancel restores the stash and reports typing for it', () => {
    const empty = draft()
    empty.store.sync(message('m1', 'original'))
    empty.store.setValue('mine')
    empty.store.cancel()
    expect(empty.store.current).toBe('')
    expect(empty.store.editing).toBeNull()
    expect(empty.typing.mock.calls).toEqual([[false]])
    const full = draft()
    full.store.setValue('unsent')
    full.store.sync(message('m1', 'original'))
    full.store.cancel()
    expect(full.store.current).toBe('unsent')
    expect(full.typing.mock.calls).toEqual([[true]])
    // Nothing to cancel outside edit mode.
    full.store.cancel()
    expect(full.typing.mock.calls).toEqual([[true]])
  })

  it('a successful save restores the stash; a failure keeps the text and the session', () => {
    const { store, typing } = draft()
    store.setValue('unsent')
    store.sync(message('m1', 'original'))
    store.setValue('mine')
    const failed = store.beginSave()
    expect(store.editing?.saving).toBe(true)
    store.completeSave(failed, false)
    expect(store.current).toBe('mine')
    expect(store.editing).toMatchObject({ saving: false, stash: 'unsent' })
    expect(typing).not.toHaveBeenCalled()
    const saved = store.beginSave()
    store.completeSave(saved, true)
    expect(store.current).toBe('unsent')
    expect(store.editing).toBeNull()
    expect(typing.mock.calls).toEqual([[true]])
    // A stale token from an earlier session is ignored.
    store.completeSave(failed, true)
    expect(store.current).toBe('unsent')
  })

  it('an external clear keeps user-changed text and restores the stash only for unchanged text', () => {
    const changed = draft()
    changed.store.setValue('unsent')
    changed.store.sync(message('m1', 'original'))
    changed.store.setValue('mine')
    changed.store.sync(null)
    expect(changed.store.current).toBe('mine')
    expect(changed.store.editing).toBeNull()
    expect(changed.typing).not.toHaveBeenCalled()
    const untouched = draft()
    untouched.store.setValue('unsent')
    untouched.store.sync(message('m1', 'original'))
    untouched.store.sync(null)
    expect(untouched.store.current).toBe('unsent')
    expect(untouched.typing).not.toHaveBeenCalled()
    const emptied = draft()
    emptied.store.setValue('unsent')
    emptied.store.sync(message('m1', 'original'))
    emptied.store.setValue('   ')
    emptied.store.sync(null)
    expect(emptied.store.current).toBe('unsent')
    // Text equal to a refreshed snapshot counts as unchanged too.
    const refreshed = draft()
    refreshed.store.setValue('unsent')
    const original = message('m1', 'original')
    refreshed.store.sync(original)
    refreshed.store.sync({ ...original, text: 'theirs', revision: 1 })
    refreshed.store.setValue('theirs')
    refreshed.store.sync(null)
    expect(refreshed.store.current).toBe('unsent')
  })

  it('resolves a clear that lands during a save by the save result', () => {
    const removed = draft()
    removed.store.setValue('unsent')
    removed.store.sync(message('m1', 'original'))
    removed.store.setValue('mine')
    const token = removed.store.beginSave()
    removed.store.sync(null)
    expect(removed.store.current).toBe('mine')
    expect(removed.store.editing).toMatchObject({ cleared: true })
    removed.store.completeSave(token, false)
    expect(removed.store.current).toBe('mine')
    expect(removed.store.editing).toBeNull()
    expect(removed.typing).not.toHaveBeenCalled()
    const saved = draft()
    saved.store.setValue('unsent')
    saved.store.sync(message('m1', 'original'))
    saved.store.setValue('mine')
    const ok = saved.store.beginSave()
    saved.store.sync(null)
    saved.store.completeSave(ok, true)
    expect(saved.store.current).toBe('unsent')
    expect(saved.store.editing).toBeNull()
    expect(saved.typing.mock.calls).toEqual([[true]])
  })

  it('switching to another message keeps the original stash and prefills the new text', () => {
    const { store, typing } = draft()
    store.setValue('unsent')
    store.sync(message('m1', 'first'))
    store.setValue('first edited')
    store.sync(message('m2', 'second'))
    expect(store.current).toBe('second')
    expect(store.editing).toMatchObject({ snapshot: { id: 'm2' }, stash: 'unsent' })
    store.cancel()
    expect(store.current).toBe('unsent')
    expect(typing.mock.calls).toEqual([[true]])
  })
})
