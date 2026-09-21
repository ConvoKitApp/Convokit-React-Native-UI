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

function newer(left: Message, right: Message): Message {
  const leftTime = (left.updatedAt ?? left.createdAt).getTime()
  const rightTime = (right.updatedAt ?? right.createdAt).getTime()
  return rightTime >= leftTime ? right : left
}

function errorField(error: unknown, field: 'code' | 'status'): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[field] : undefined
}
/** A targeted read whose message the server no longer knows; membership failures carry no code. */
const isTargetMiss = (error: unknown): boolean => errorField(error, 'code') === 'MESSAGE_NOT_FOUND'
const isNotFound = (error: unknown): boolean => errorField(error, 'status') === 404

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
  })

  readerIdsFor(message: Message): ReadonlySet<string> {
    return resolveReaderIds(message, this.positions, this.reads)
  }

  async loadInitial(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    await this.clearSubscriptions()
    this.messages.clear(); this.deleted.clear(); this.typing.clear(); this.reads.clear(); this.positions.clear()
    this.resetAcknowledgements()
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
      const canonical = new Map(page.filter(row => !this.deleted.has(row.id)).map(row => [row.id, row]))
      for (const row of this.messages.values()) {
        if (isConvoKitPendingMessage(row)) canonical.set(row.id, row)
      }
      this.messages = canonical
      this.mergeParticipantReads(conversation)
      this.error = null
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
      text: text || null, media, createdAt: new Date(), updatedAt: null,
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
    const existing = this.messages.get(row.id)
    this.messages.set(row.id, existing ? newer(existing, complete) : complete); this.rendered = true
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
      const existing = this.messages.get(row.id)
      this.messages.set(row.id, existing ? newer(existing, row) : row); this.rendered = true
    }
  }
  private remove(id: string): void {
    this.deleted.add(id); this.messages.delete(id)
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
    this.resetAcknowledgements()
    this.error = new Error('ConvoKit session ended'); this.emit()
  }
  private async clearSubscriptions(): Promise<void> {
    await closeAll(this.subscriptions); this.subscriptions.clear()
  }
}
