import {
  createClientMessageId,
  type Conversation,
  type Message,
  type MessageMedia,
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
  readAtByUserId: ReadonlyMap<string, Date>
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

function sortMessages(messages: Iterable<Message>): Message[] {
  return [...messages].sort((left, right) =>
    left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
}

function newer(left: Message, right: Message): Message {
  const leftTime = (left.updatedAt ?? left.createdAt).getTime()
  const rightTime = (right.updatedAt ?? right.createdAt).getTime()
  return rightTime >= leftTime ? right : left
}

export class ConversationController extends ObservableStore<ConversationState> {
  readonly conversationId: string
  readonly messagePageSize: number
  private conversation: Conversation | null = null
  private messages = new Map<string, Message>()
  private deleted = new Set<string>()
  private typing = new Set<string>()
  private reads = new Map<string, Date>()
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
    if (isConvoKitPendingMessage(message)) return new Set()
    return new Set([...this.reads].filter(([id, at]) =>
      id !== message.senderId && at.getTime() >= message.createdAt.getTime()).map(([id]) => id))
  }

  async loadInitial(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    await this.clearSubscriptions()
    this.messages.clear(); this.deleted.clear(); this.typing.clear(); this.reads.clear()
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
      for (const participant of conversation.participants) {
        if (participant.lastReadAt) this.reads.set(participant.appUserId, participant.lastReadAt)
      }
      this.merge(page); this.hasOlder = page.length === this.messagePageSize
      this.bind(generation)
      if (this.options.markReadOnLoad !== false) await this.markRead()
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
      this.assertRows(page); this.conversation = conversation
      const canonical = new Map(page.filter(row => !this.deleted.has(row.id)).map(row => [row.id, row]))
      for (const row of this.messages.values()) {
        if (isConvoKitPendingMessage(row)) canonical.set(row.id, row)
      }
      this.messages = canonical
      this.reads.clear()
      for (const participant of conversation.participants) {
        if (participant.lastReadAt) this.reads.set(participant.appUserId, participant.lastReadAt)
      }
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

  async markRead(): Promise<void> {
    const generation = this.generation
    try {
      await this.options.client.markConversationRead(this.conversationId)
      if (this.current(generation)) this.reads.set(this.options.client.currentUserId, new Date())
    } catch (error) { if (this.current(generation)) this.error = error }
    if (this.current(generation)) this.emit()
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
    this.subscriptions.add(client.onMessage(this.conversationId, event => { void this.receive(event.message, generation) }))
    this.subscriptions.add(client.onMessageDeleted(this.conversationId, event => {
      if (!this.current(generation) || event.conversationId !== this.conversationId) return
      this.deleted.add(event.id); this.messages.delete(event.id); this.emit()
    }))
    this.subscriptions.add(client.onReadReceipt(this.conversationId, event => {
      if (!this.current(generation)) return
      const previous = this.reads.get(event.userId)
      if (!previous || event.readAt > previous) this.reads.set(event.userId, event.readAt)
      this.emit()
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
  private async receive(row: Message, generation: number): Promise<void> {
    if (!this.current(generation) || row.conversationId !== this.conversationId || this.deleted.has(row.id)) return
    let complete = row
    try { complete = await this.options.client.getMessage(row.id) } catch { /* Keep the authorized live row. */ }
    if (!this.current(generation) || this.deleted.has(row.id)) return
    const existing = this.messages.get(row.id)
    this.messages.set(row.id, existing ? newer(existing, complete) : complete)
    if (complete.clientMessageId) {
      for (const candidate of this.messages.values()) {
        if (isConvoKitPendingMessage(candidate) && candidate.clientMessageId === complete.clientMessageId &&
            candidate.senderId === complete.senderId) this.messages.delete(candidate.id)
      }
    }
    if (this.options.markReadOnReceive !== false && complete.senderId !== this.options.client.currentUserId) void this.markRead()
    this.emit()
  }
  private merge(rows: readonly Message[]): void {
    for (const row of rows) {
      if (row.conversationId !== this.conversationId || this.deleted.has(row.id)) continue
      const existing = this.messages.get(row.id)
      this.messages.set(row.id, existing ? newer(existing, row) : row)
    }
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
    ++this.generation; this.messages.clear(); this.conversation = null; this.typing.clear(); this.reads.clear()
    this.error = new Error('ConvoKit session ended'); this.emit()
  }
  private async clearSubscriptions(): Promise<void> {
    await closeAll(this.subscriptions); this.subscriptions.clear()
  }
}
