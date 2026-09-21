import type { Message } from '@convokitapp/react-native'
import { ObservableStore } from './store'

export interface ComposerDraftState { value: string }

/** One edit session: the host's snapshot, what the field was prefilled with, the unsent draft stashed when
 * edit mode began, and whether a save is in flight or the host left edit mode during it.
 */
export interface EditSession {
  snapshot: Message
  prefilled: string
  stash: string
  saving: boolean
  cleared: boolean
}

/** The composer field of one mounted conversation view and its 0.8 edit session. Edit mode itself belongs
 * to the host (`editingMessage`): `sync` mirrors it during render, so it never emits or reports typing;
 * entering edit mode stashes the unsent draft and prefills the field with the snapshot text silently,
 * `cancel` and a successful save restore the stash and report typing like the send path, and an external
 * clear (the row was removed) keeps user-changed text, restoring the stash only when the field is empty or
 * still equals the snapshot text.
 */
export class ComposerDraft extends ObservableStore<ComposerDraftState> {
  /** The view's `onTypingChanged`, re-assigned every render; only user-driven restores call it. */
  onTyping: ((typing: boolean) => void) | undefined
  private value = ''
  private session: EditSession | null = null

  getSnapshot = (): ComposerDraftState => ({ value: this.value })

  /** The field content, for handlers that run outside a render. */
  get current(): string { return this.value }
  get editing(): EditSession | null { return this.session }

  /** Set the field; typing is the caller's decision, as with the 0.7 `setValue`. */
  setValue(value: string): void { this.value = value; this.emit() }

  /** Mirror the host's edit mode. Called during render, so it mutates only and never emits. */
  sync(editing: Message | null): void {
    const session = this.session
    if (!editing) {
      if (!session) return
      // The host left edit mode while a save is in flight: `completeSave` decides what the field keeps.
      if (session.saving) { session.cleared = true; return }
      this.session = null
      if (this.unchanged(session)) this.value = session.stash
      return
    }
    if (session && session.snapshot.id === editing.id) { session.snapshot = editing; session.cleared = false; return }
    // A new session (or a switch to another message) keeps the original stash and prefills silently.
    const prefilled = editing.text ?? ''
    this.session = { snapshot: editing, prefilled, stash: session ? session.stash : this.value, saving: false, cleared: false }
    this.value = prefilled
  }

  /** The user left edit mode: restore the stash and report typing for it. */
  cancel(): void {
    const session = this.session
    if (!session) return
    this.session = null
    this.restore(session.stash)
  }

  /** Mark the session as saving; the field keeps its text until `completeSave`. */
  beginSave(): EditSession | null {
    if (this.session) this.session.saving = true
    return this.session
  }

  /** Resolve a save: success restores the stash; a failure keeps the edited text, and keeps the session
   * unless the host left edit mode meanwhile (the text then stays as the unsent draft). A token from a
   * superseded session is ignored.
   */
  completeSave(token: EditSession | null, ok: boolean): void {
    if (!token || this.session !== token) return
    token.saving = false
    if (ok) { this.session = null; this.restore(token.stash); return }
    if (token.cleared) { this.session = null; this.emit() }
  }

  private unchanged(session: EditSession): boolean {
    return this.value.trim() === '' || this.value === session.prefilled || this.value === (session.snapshot.text ?? '')
  }

  private restore(stash: string): void {
    this.value = stash; this.emit()
    this.onTyping?.(stash.trim().length > 0)
  }
}
