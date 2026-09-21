import {
  covers,
  createClientMessageId,
  readThrough,
  type Conversation,
  type Message,
  type MessageEvent,
  type MessageMedia,
  type ReadPosition,
  type RealtimeSubscription,
} from '@convokitapp/react-native'
import type { ConvoKitUiClient } from './client'
import { closeAll, ObservableStore } from './store'

const pendingPrefix = 'convokit-pending-'
export const isConvoKitPendingMessage = (message: Message): boolean => message.id.startsWith(pendingPrefix)

export interface ConversationState {
  conversation: Conversation | null
  messages: readonly Message[]
  typingUserIds: ReadonlySet<string>
  /** Last acknowledgement time per user; kept for custom renderers. */
  readAtByUserId: ReadonlyMap<string, Date>
  /** Monotonic server read positions per user; absent for legacy rows without a position. */
  readPositionByUserId: ReadonlyMap<string, ReadPosition>
  currentUserId: string
  isInitialLoading: boolean
  isLoadingOlder: boolean
  isSending: boolean
  isReconciling: boolean
  hasOlderMessages: boolean
  hasLoaded: boolean
  error: unknown
  /** The 0.8 edit session: the snapshot of the caller's own message being edited, captured by
   * `startEditing` and refreshed only by a conflict; its `revision` is what `saveEdit` sends. Null
   * outside edit mode; cleared when that row is removed.
   */
  editingMessage: Message | null
  /** Whether the adapter implements the 0.8 `editMessage` / `deleteMessage`; without them nothing renders
   * an edit or delete action and `startEditing` is a no-op.
   */
  canEditMessages: boolean
  canDeleteMessages: boolean
}

export interface ConversationControllerOptions {
  conversationId: string
  client: ConvoKitUiClient
  messagePageSize?: number
  markReadOnLoad?: boolean
  markReadOnReceive?: boolean
  typingTimeoutMs?: number
  autoLoad?: boolean
}

interface MessageCursor { id: string; createdAt: Date }

/** Message cursor order: (createdAt, id) with ids compared by code units, matching the server. */
function compareCursor(left: MessageCursor, right: MessageCursor): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

function sortMessages(messages: Iterable<Message>): Message[] {
  return [...messages].sort(compareCursor)
}

/** Row precedence: when both rows carry a usable revision and they differ, the higher one wins and a lower
 * one never overwrites; equal revisions (and rows without one: pending rows, 0.7 backends where every row
 * is 0) fall back to the later `updatedAt ?? createdAt`, ties to the incoming row.
 */
function newer(left: Message, right: Message): Message {
  if (usableRevision(left) && usableRevision(right) && left.revision !== right.revision) {
    return right.revision > left.revision ? right : left
  }
  const leftTime = (left.updatedAt ?? left.createdAt).getTime()
  const rightTime = (right.updatedAt ?? right.createdAt).getTime()
  return rightTime >= leftTime ? right : left
}
/** A revision takes part in precedence only as a non-negative integer; consumer-built rows without one keep
 * the timestamp rule. Two usable revisions that differ always include one above 0.
 */
function usableRevision(row: Message): boolean {
  return Number.isInteger(row.revision) && row.revision >= 0
}

function errorField(error: unknown, field: 'code' | 'status'): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[field] : undefined
}
/** A targeted read whose message the server no longer knows; membership failures carry no code. */
const isTargetMiss = (error: unknown): boolean => errorField(error, 'code') === 'MESSAGE_NOT_FOUND'
const isNotFound = (error: unknown): boolean => errorField(error, 'status') === 404
/** A stale-revision rejection of an author edit (the 0.8 backend's 409 `REVISION_CONFLICT`). */
const isConflict = (error: unknown): boolean =>
  errorField(error, 'code') === 'REVISION_CONFLICT' || errorField(error, 'status') === 409
/** The local conflict: a newer row for the edited id reached the store, no request involved. */
const conflictError = (): Error =>
  Object.assign(new Error('Message was changed since it was loaded'), { code: 'REVISION_CONFLICT' })
const unsupported = (member: string): Error =>
  new Error(`This ConvoKitUiClient adapter does not implement ${member} (0.8)`)

/** Readers of a message under the unified rule: a user's read position when known, otherwise the
 * acknowledgement time. The sender never reads their own message and pending rows have no readers.
 */
export function resolveReaderIds(
  message: Message,
  readPositionByUserId: ReadonlyMap<string, ReadPosition> = new Map(),
  readAtByUserId: ReadonlyMap<string, Date> = new Map(),
): ReadonlySet<string> {
  const readerIds = new Set<string>()
  if (isConvoKitPendingMessage(message)) return readerIds
  for (const id of new Set([...readPositionByUserId.keys(), ...readAtByUserId.keys()])) {
    if (id === message.senderId) continue
    const reader = { readPosition: readPositionByUserId.get(id) ?? null, lastReadAt: readAtByUserId.get(id) ?? null }
    if (readThrough(reader, message)) readerIds.add(id)
  }
  return readerIds
}

export class ConversationController extends ObservableStore<ConversationState> {
  readonly conversationId: string
  readonly messagePageSize: number
  private conversation: Conversation | null = null
  private messages = new Map<string, Message>()
  private deleted = new Set<string>()
  private typing = new Set<string>()
  private reads = new Map<string, Date>()
  private positions = new Map<string, ReadPosition>()
  private subscriptions = new Set<RealtimeSubscription>()
  private remoteTypingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private localTypingTimer?: ReturnType<typeof setTimeout>
  private localTypingRenewal?: ReturnType<typeof setTimeout>
  private generation = 0
  private initialLoading = false
  private loadingOlder = false
  private sending = false
  private reconciling = false
  private hasOlder = true
  private hasLoaded = false
  private error: unknown = null
  private disposed = false
  private sessionIdentity: object | null = null
  // The 0.8 edit session: the snapshot whose revision every save sends (refreshed only by a conflict), the id
  // whose save is in flight (its row images wait for the response instead of raising a conflict), and the
  // adapter support decided once at construction (`listInbox` precedent).
  private editing: Message | null = null
  private saving: string | null = null
  private readonly supportsEdit: boolean
  private readonly supportsDelete: boolean
  // Acknowledgements: visible until the platform says otherwise, one request in flight, a boolean
  // follow-up resolved at send time, and the ids the server refused so a retry skips them.
  private visible = true
  private acknowledging = false
  private followUp = false
  private suppressed = false
  private inFlight: MessageCursor | null = null
  private acknowledged: MessageCursor | null = null
  private unacknowledgeable = new Set<string>()
  // Private state captured once per open, the first time `conversation` goes from null to a DTO (the
  // `loadInitial` happy path, or a reconcile after a transient first-load failure), never from a later
  // refresh: the version every targeted acknowledgement of this open sends (undefined from a 0.6 backend,
  // which serves no `membership`), the version an opened-but-empty marked room clears its marker with
  // (null once issued or when nothing was marked), and whether a confirmed row was ever rendered.
  private openedVersion: number | undefined
  private pendingClear: number | null = null
  private rendered = false

  constructor(private options: ConversationControllerOptions) {
    super()
    this.conversationId = options.conversationId.trim()
    if (!this.conversationId) throw new Error('conversationId is required')
    this.messagePageSize = options.messagePageSize ?? 30
    if (this.messagePageSize < 1 || this.messagePageSize > 100) {
      throw new RangeError('messagePageSize must be between 1 and 100')
    }
    this.supportsEdit = typeof options.client.editMessage === 'function'
    this.supportsDelete = typeof options.client.deleteMessage === 'function'
    if (options.autoLoad !== false) void this.loadInitial()
  }

  getSnapshot = (): ConversationState => ({
    conversation: this.conversation,
    messages: sortMessages(this.messages.values()),
    typingUserIds: new Set(this.typing),
    readAtByUserId: new Map(this.reads),
    readPositionByUserId: new Map(this.positions),
    currentUserId: this.options.client.currentUserId,
    isInitialLoading: this.initialLoading,
    isLoadingOlder: this.loadingOlder,
    isSending: this.sending,
    isReconciling: this.reconciling,
    hasOlderMessages: this.hasOlder,
    hasLoaded: this.hasLoaded,
    error: this.error,
    editingMessage: this.editing,
    canEditMessages: this.supportsEdit,
    canDeleteMessages: this.supportsDelete,
  })

  readerIdsFor(message: Message): ReadonlySet<string> {
    return resolveReaderIds(message, this.positions, this.reads)
  }

  async loadInitial(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    await this.clearSubscriptions()
    this.messages.clear(); this.deleted.clear(); this.typing.clear(); this.reads.clear(); this.positions.clear()
    this.resetAcknowledgements(); this.editing = null; this.saving = null
    this.conversation = null; this.error = null; this.hasOlder = true; this.initialLoading = true; this.emit()
    this.sessionIdentity = this.options.client.sessionIdentity
    try {
      if (!this.sessionIdentity) throw new Error('Connect a ConvoKit user before loading a conversation')
      const [conversation, page] = await Promise.all([
        this.options.client.getConversation(this.conversationId),
        this.options.client.getMessages({ conversationId: this.conversationId, limit: this.messagePageSize, offset: 0 }),
      ])
      if (!this.current(generation)) return
      this.assertRows(page)
      this.conversation = conversation
      this.capture(conversation)
      this.mergeParticipantReads(conversation)
      this.merge(page); this.hasOlder = page.length === this.messagePageSize
      this.bind(generation); this.emit()
      // Render first, then acknowledge what was rendered.
      if (this.options.markReadOnLoad !== false) await this.acknowledge()
    } catch (error) { if (this.current(generation)) this.error = error }
    finally {
      if (this.current(generation)) { this.initialLoading = false; this.hasLoaded = true; this.emit() }
    }
  }

  async refresh(): Promise<void> {
    if (!this.hasLoaded) return this.loadInitial()
    if (this.reconciling || this.disposed) return
    const generation = this.generation; this.reconciling = true; this.emit()
    try {
      const [conversation, page] = await Promise.all([
        this.options.client.getConversation(this.conversationId),
        this.options.client.getMessages({ conversationId: this.conversationId, limit: Math.max(this.messages.size, this.messagePageSize), offset: 0 }),
      ])
      if (!this.current(generation)) return
      this.assertRows(page)
      // A reconcile after a failed first load is this open's first DTO; replacing one never recaptures.
      const opening = this.conversation === null
      this.conversation = conversation
      if (opening) this.capture(conversation)
      // The page is the rendered window, but each row still merges under precedence (D11): a page fetched
      // before an edit never rewinds the newer row the edit response or its UPDATE image already brought.
      const canonical = new Map<string, Message>()
      for (const row of page) {
        if (this.deleted.has(row.id)) continue
        const existing = this.messages.get(row.id)
        canonical.set(row.id, existing ? newer(existing, row) : row)
      }
      for (const row of this.messages.values()) {
        if (isConvoKitPendingMessage(row)) canonical.set(row.id, row)
      }
      this.messages = canonical
      // A row the page no longer carries is no longer rendered: its edit session ends with it.
      if (this.editing && !canonical.has(this.editing.id)) this.editing = null
      this.mergeParticipantReads(conversation)
      this.error = null
      this.detectConflict()
    } catch (error) { if (this.current(generation)) this.error = error }
    finally { if (this.current(generation)) { this.reconciling = false; this.emit() } }
  }

  async loadOlderMessages(): Promise<void> {
    if (this.loadingOlder || !this.hasOlder || this.disposed) return
    const generation = this.generation
    const oldest = sortMessages(this.messages.values()).find(row => !isConvoKitPendingMessage(row))
    this.loadingOlder = true; this.error = null; this.emit()
    try {
      const page = await this.options.client.getMessages({
        conversationId: this.conversationId, limit: this.messagePageSize, offset: 0,
        ...(oldest ? { beforeCreatedAt: oldest.createdAt, beforeId: oldest.id } : {}),
      })
      if (!this.current(generation)) return
      this.assertRows(page); this.merge(page); this.hasOlder = page.length === this.messagePageSize
    } catch (error) { if (this.current(generation)) this.error = error }
    finally { if (this.current(generation)) { this.loadingOlder = false; this.emit() } }
  }

  async sendMessage(input: { text?: string; media?: MessageMedia[] }): Promise<Message | null> {
    const text = input.text?.trim()
    const media = input.media ?? []
    if ((!text || !text.length) && !media.length || this.sending || this.disposed) return null
    const generation = this.generation
    const clientMessageId = createClientMessageId()
    const pending: Message = {
      id: `${pendingPrefix}${clientMessageId}`, clientMessageId,
      conversationId: this.conversationId, senderId: this.options.client.currentUserId,
      text: text || null, media, createdAt: new Date(), updatedAt: null, revision: 0,
    }
    this.messages.set(pending.id, pending); this.sending = true; this.error = null; this.emit()
    try {
      const confirmed = await this.options.client.sendMessage({
        conversationId: this.conversationId, clientMessageId,
        ...(text ? { text } : {}), ...(media.length ? { media } : {}),
      })
      if (!this.current(generation)) return null
      if (confirmed.conversationId !== this.conversationId || confirmed.senderId !== pending.senderId ||
          confirmed.clientMessageId && confirmed.clientMessageId !== clientMessageId) {
        throw new Error('Send response does not match the pending message')
      }
      this.messages.delete(pending.id)
      if (!this.deleted.has(confirmed.id)) this.merge([confirmed])
      await this.updateTyping(false)
      return this.messages.get(confirmed.id) ?? confirmed
    } catch (error) {
      if (this.current(generation)) {
        const canonical = [...this.messages.values()].find(row => row.clientMessageId === clientMessageId && !isConvoKitPendingMessage(row))
        this.messages.delete(pending.id)
        if (canonical) return canonical
        this.error = error
      }
      return null
    } finally { if (this.current(generation)) { this.sending = false; this.emit() } }
  }

  /** Enter edit mode on one of the caller's own confirmed messages: the current row becomes the snapshot
   * whose `revision` every save of this session sends. A no-op for foreign, pending, removed or unknown
   * rows, for a `READ` role when the conversation reports one, and for adapters without `editMessage`.
   */
  startEditing(messageId: string): void {
    if (!this.supportsEdit || this.disposed) return
    const row = this.messages.get(messageId)
    if (!row || !this.editable(row) || this.role() === 'READ') return
    this.editing = row; this.error = null; this.emit()
  }

  /** Leave edit mode without a request. */
  cancelEditing(): void {
    if (!this.editing) return
    this.editing = null; this.emit()
  }

  /** Save the edit session: the trimmed text (empty clears the caption of a message with attachments; a
   * text-only message is never saved empty, no request) is sent with the snapshot's revision, never the
   * live row's. Success merges the response under the deletion and precedence guards, clears edit mode
   * and resolves `true`. A stale revision (409 `REVISION_CONFLICT`) reloads the row once: the row shows
   * the new content, the snapshot is refreshed so the next save carries the fresh revision, `error`
   * carries the conflict, and the edited text is left to the composer. A reload or a save that answers
   * `MESSAGE_NOT_FOUND` removes the row and leaves edit mode. Any other failure (a 0.7 backend's uncoded
   * 404, 403, network) sets `error` and keeps the row and the session; every failure resolves `false`.
   * While the save is in flight, row images for the edited id (its own UPDATE image often beats the
   * response) merge without raising a conflict: a success ends edit mode, a 409 reloads the row, and any
   * other failure re-checks the rendered row so a genuinely newer one is a conflict after all.
   */
  async saveEdit(text: string): Promise<boolean> {
    const edit = this.options.client.editMessage
    if (typeof edit !== 'function') throw unsupported('editMessage')
    const snapshot = this.editing
    if (!snapshot || this.saving !== null || this.disposed) return false
    const trimmed = text.trim()
    const normalized = trimmed === '' ? null : trimmed
    if (normalized === null && !snapshot.media.length) return false
    const generation = this.generation
    const id = snapshot.id
    this.saving = id; this.error = null; this.emit()
    try {
      const row = await edit.call(this.options.client, id, { text: normalized, revision: snapshot.revision })
      if (!this.current(generation)) return false
      if (row.id !== id || row.conversationId !== this.conversationId) {
        throw new Error('Edit response does not match the edited message')
      }
      // Leave edit mode first so the response is not read as a conflict against its own snapshot; a late
      // response for a row removed meanwhile is dropped, edit mode was left with the removal.
      if (this.editing?.id === id) this.editing = null
      if (!this.deleted.has(id)) this.store(row)
      this.error = null
      return true
    } catch (error) {
      if (!this.current(generation) || this.deleted.has(id)) return false
      this.saving = null
      if (isConflict(error)) await this.reloadConflict(id, error, generation)
      else if (isTargetMiss(error)) { this.remove(id); this.error = error }
      else {
        this.error = error
        // A newer row image that arrived during the failed request is a conflict after all.
        this.detectConflict()
      }
      return false
    } finally { if (this.current(generation)) { this.saving = null; this.emit() } }
  }

  /** Delete one of the caller's own confirmed messages through the adapter. Success, or a server that no
   * longer knows the message (`MESSAGE_NOT_FOUND`), tombstones and removes the row (leaving edit mode when
   * it was that row) and resolves `true`; any other failure sets `error`, keeps the row and resolves
   * `false`. Never removes a row before the server answers.
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    const remove = this.options.client.deleteMessage
    if (typeof remove !== 'function') throw unsupported('deleteMessage')
    const row = this.messages.get(messageId)
    if (!row || !this.editable(row) || this.disposed) return false
    const generation = this.generation
    this.error = null; this.emit()
    try { await remove.call(this.options.client, messageId) }
    catch (error) {
      if (!this.current(generation)) return false
      if (!isTargetMiss(error)) { this.error = error; this.emit(); return false }
    }
    if (!this.current(generation)) return false
    this.remove(messageId); this.emit()
    return true
  }

  /** Acknowledge through the newest rendered message (clearing the caller's unread marker when the version
   * captured at open is still current), or clear the marker of a marked room that rendered nothing.
   * Deferred while hidden; coalesced with other requests.
   */
  markRead(): Promise<void> { return this.acknowledge() }

  /** Report platform visibility. Hidden defers acknowledgements; becoming visible re-issues a deferred one. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (visible && this.suppressed) { this.suppressed = false; void this.acknowledge() }
  }

  async updateTyping(isTyping: boolean): Promise<void> {
    clearTimeout(this.localTypingTimer)
    if (isTyping) {
      this.localTypingTimer = setTimeout(() => { void this.updateTyping(false) }, this.typingTimeout)
      if (this.localTypingRenewal) return
      this.localTypingRenewal = setTimeout(() => { this.localTypingRenewal = undefined }, this.typingTimeout / 2)
    } else {
      clearTimeout(this.localTypingRenewal); this.localTypingRenewal = undefined
    }
    try { await this.options.client.sendTyping({ conversationId: this.conversationId, isTyping }) }
    catch (error) { if (!this.disposed) { this.error = error; this.emit() } }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; ++this.generation
    clearTimeout(this.localTypingTimer); clearTimeout(this.localTypingRenewal)
    for (const timer of this.remoteTypingTimers.values()) clearTimeout(timer)
    void this.options.client.sendTyping({ conversationId: this.conversationId, isTyping: false }).catch(() => undefined)
    await this.clearSubscriptions(); this.listeners.clear()
  }

  private get typingTimeout(): number { return this.options.typingTimeoutMs ?? 3000 }
  private bind(generation: number): void {
    const client = this.options.client
    this.subscriptions.add(client.onMessage(this.conversationId, event => { void this.receive(event.message, event.type, generation) }))
    this.subscriptions.add(client.onMessageDeleted(this.conversationId, event => {
      if (!this.current(generation) || event.conversationId !== this.conversationId) return
      this.remove(event.id); this.emit()
    }))
    this.subscriptions.add(client.onReadReceipt(this.conversationId, event => {
      if (!this.current(generation)) return
      if (this.mergeRead(event.userId, event.readAt, event.readPosition)) this.emit()
    }))
    this.subscriptions.add(client.onTyping(this.conversationId, event => {
      if (!this.current(generation) || event.userId === client.currentUserId) return
      clearTimeout(this.remoteTypingTimers.get(event.userId))
      if (event.isTyping) {
        this.typing.add(event.userId)
        this.remoteTypingTimers.set(event.userId, setTimeout(() => {
          this.typing.delete(event.userId); this.remoteTypingTimers.delete(event.userId); this.emit()
        }, this.typingTimeout))
      } else { this.typing.delete(event.userId); this.remoteTypingTimers.delete(event.userId) }
      this.emit()
    }))
    this.subscriptions.add(client.onConnectionEvent(event => {
      if (!this.current(generation)) return
      if (event.status === 'SUBSCRIBED' &&
          (event.topic === `messages:${this.conversationId}` || event.topic === `conversation:${this.conversationId}`)) {
        void this.refresh()
      }
    }, () => this.retire(generation)))
  }
  private async receive(row: Message, type: MessageEvent['type'], generation: number): Promise<void> {
    if (!this.current(generation) || row.conversationId !== this.conversationId || this.deleted.has(row.id)) return
    const known = this.messages.has(row.id)
    let complete = row
    try { complete = await this.options.client.getMessage(row.id) }
    catch (error) {
      if (!this.current(generation)) return
      // A row the server no longer has is a deletion; any other failure keeps the authorized live row.
      if (isNotFound(error)) { this.remove(row.id); this.emit(); return }
    }
    if (!this.current(generation) || this.deleted.has(row.id)) return
    this.store(complete)
    if (complete.clientMessageId) {
      for (const candidate of this.messages.values()) {
        if (isConvoKitPendingMessage(candidate) && candidate.clientMessageId === complete.clientMessageId &&
            candidate.senderId === complete.senderId) this.messages.delete(candidate.id)
      }
    }
    this.emit()
    // Only a newly rendered foreign message is a read trigger; edits and echoes of known rows are not.
    if (type === 'insert' && !known && complete.senderId !== this.options.client.currentUserId &&
        this.options.markReadOnReceive !== false) void this.acknowledge()
  }
  private merge(rows: readonly Message[]): void {
    for (const row of rows) {
      if (row.conversationId !== this.conversationId || this.deleted.has(row.id)) continue
      this.store(row)
    }
  }
  /** Keep the newer of the known row and an incoming one (D11), then check the edit session against it. */
  private store(row: Message): void {
    const existing = this.messages.get(row.id)
    this.messages.set(row.id, existing ? newer(existing, row) : row); this.rendered = true
    this.detectConflict()
  }
  /** The local conflict: a row for the edited id with a higher revision than the snapshot (an UPDATE image,
   * a hydration, a reconcile) enters the same state as a 409 without a round trip. The snapshot is replaced
   * so the next save carries the fresh revision; the composer keeps its text and edit mode stays on. Not
   * while that row's own save is in flight: its images wait for the response (`saveEdit`).
   */
  private detectConflict(): void {
    const snapshot = this.editing
    if (!snapshot || snapshot.id === this.saving) return
    const row = this.messages.get(snapshot.id)
    if (row && usableRevision(row) && row.revision > snapshot.revision) { this.editing = row; this.error = conflictError() }
  }
  /** The 409 path: one `getMessage`; the row merges under the guards and becomes the new snapshot, `error`
   * carries the conflict. A reload that answers `MESSAGE_NOT_FOUND` removes the row and leaves edit mode;
   * another reload failure keeps the snapshot and surfaces that failure.
   */
  private async reloadConflict(id: string, conflict: unknown, generation: number): Promise<void> {
    try {
      const row = await this.options.client.getMessage(id)
      if (!this.current(generation) || this.deleted.has(id)) return
      if (row.id !== id || row.conversationId !== this.conversationId) throw new Error('Reloaded message does not match')
      this.store(row)
      if (this.editing?.id === id) this.editing = this.messages.get(id) ?? row
      this.error = conflict
    } catch (error) {
      if (!this.current(generation) || this.deleted.has(id)) return
      if (isTargetMiss(error)) this.remove(id)
      this.error = error
    }
  }
  /** Own, confirmed and not removed: the rows an author may edit or delete. */
  private editable(row: Message): boolean {
    return row.senderId === this.options.client.currentUserId && !isConvoKitPendingMessage(row) && !this.deleted.has(row.id)
  }
  /** The caller's role when the conversation reports it: the self-only `membership` (0.7 backend), else
   * the caller's own `participants` entry.
   */
  private role(): string | undefined {
    const me = this.options.client.currentUserId
    return this.conversation?.membership?.role ??
      this.conversation?.participants.find(row => row.appUserId === me || row.id === me)?.role
  }
  private remove(id: string): void {
    this.deleted.add(id); this.messages.delete(id)
    if (this.editing?.id === id) this.editing = null
    // A removed acknowledgement target can never be confirmed; fall back to the next newest row once.
    const inFlight = this.inFlight?.id === id
    if (!inFlight && this.acknowledged?.id !== id) return
    this.unacknowledgeable.add(id)
    if (!inFlight) this.acknowledged = null
    if (this.acknowledging) this.followUp = true
    else void this.acknowledge()
  }
  private mergeParticipantReads(conversation: Conversation): void {
    for (const participant of conversation.participants) {
      this.mergeRead(participant.appUserId, participant.lastReadAt, participant.readPosition)
    }
  }
  /** Advance a user's read state monotonically: ack time by max, position by cursor order. */
  private mergeRead(userId: string, readAt: Date | null | undefined, readPosition: ReadPosition | null | undefined): boolean {
    if (!userId) return false
    let changed = false
    if (readAt && Number.isFinite(readAt.getTime())) {
      const previous = this.reads.get(userId)
      if (!previous || readAt.getTime() > previous.getTime()) { this.reads.set(userId, readAt); changed = true }
    }
    if (readPosition && Number.isFinite(readPosition.createdAt.getTime())) {
      const previous = this.positions.get(userId)
      if (!previous || !covers(previous, { id: readPosition.messageId, createdAt: readPosition.createdAt })) {
        this.positions.set(userId, readPosition); changed = true
      }
    }
    return changed
  }
  /** The newest rendered, confirmed message the server has not refused as a target. */
  private resolveTarget(): MessageCursor | null {
    const rows = sortMessages(this.messages.values())
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!
      if (!isConvoKitPendingMessage(row) && !this.unacknowledgeable.has(row.id)) return { id: row.id, createdAt: row.createdAt }
    }
    return null
  }
  private async acknowledge(): Promise<void> {
    if (this.disposed) return
    if (!this.visible) { this.suppressed = true; return }
    if (this.acknowledging) { this.followUp = true; return }
    const generation = this.generation
    this.acknowledging = true
    try {
      do {
        this.followUp = false
        if (!this.visible) { this.suppressed = true; return }
        const target = this.resolveTarget()
        // Nothing rendered: the only request is the once-per-open clear of a marked room (D9); a row that
        // arrives meanwhile sets `followUp` and is acknowledged by the next turn of the loop.
        if (!target) { await this.clearMarker(generation); if (!this.current(generation)) return; continue }
        if (this.acknowledged && compareCursor(target, this.acknowledged) <= 0) return
        this.inFlight = target
        try {
          await this.options.client.markConversationRead(this.conversationId, {
            throughMessageId: target.id,
            ...(this.openedVersion === undefined ? {} : { privateStateVersion: this.openedVersion }),
          })
          if (!this.current(generation)) return
          if (!this.unacknowledgeable.has(target.id)) this.acknowledged = target
        } catch (error) {
          if (!this.current(generation)) return
          if (!isTargetMiss(error)) { this.error = error; this.emit(); return }
          this.unacknowledgeable.add(target.id); this.followUp = true
        } finally { if (this.inFlight === target) this.inFlight = null }
      } while (this.followUp)
    } finally { if (this.current(generation)) this.acknowledging = false }
  }
  private resetAcknowledgements(): void {
    this.acknowledging = false; this.followUp = false; this.suppressed = false
    this.inFlight = null; this.acknowledged = null; this.unacknowledgeable.clear()
    this.openedVersion = undefined; this.pendingClear = null; this.rendered = false
  }
  /** Capture the caller's private state for this open from the DTO's self-only `membership` (absent on a
   * 0.6 backend: acknowledgements then carry no version and nothing is ever cleared without one).
   */
  private capture(conversation: Conversation): void {
    const membership = conversation.membership
    this.openedVersion = membership?.privateStateVersion
    this.pendingClear = membership && membership.unreadMarkedAt !== null ? membership.privateStateVersion : null
  }
  /** An opened room that was marked unread and rendered nothing has no target to acknowledge, so it clears
   * the marker through the adapter instead, conditionally on the captured version and once per open; a
   * `cleared: false` answer (the marker moved on) is not an error, and adapters without the member keep it.
   */
  private async clearMarker(generation: number): Promise<void> {
    const version = this.pendingClear
    const clear = this.options.client.clearConversationUnread
    if (version === null || this.rendered || !clear) return
    this.pendingClear = null
    try { await clear.call(this.options.client, this.conversationId, { ifVersion: version }) }
    catch (error) { if (this.current(generation)) { this.error = error; this.emit() } }
  }
  private assertRows(rows: readonly Message[]): void {
    if (rows.length > Math.max(this.messagePageSize, this.messages.size, this.messagePageSize) ||
        rows.some(row => !row.id.trim() || row.conversationId !== this.conversationId)) throw new Error('Invalid message page')
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.sessionIdentity === this.options.client.sessionIdentity
  }
  private retire(generation: number): void {
    if (this.disposed || generation !== this.generation) return
    ++this.generation; this.messages.clear(); this.conversation = null; this.typing.clear(); this.reads.clear(); this.positions.clear()
    this.resetAcknowledgements(); this.editing = null; this.saving = null
    this.error = new Error('ConvoKit session ended'); this.emit()
  }
  private async clearSubscriptions(): Promise<void> {
    await closeAll(this.subscriptions); this.subscriptions.clear()
  }
}
