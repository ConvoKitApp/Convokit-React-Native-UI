import type {
  ConvoKitClient, Conversation, InboxPage, MarkConversationReadOptions, Message, MessageDeletedEvent, MessageEvent,
  MessageMedia, ReadEvent, RealtimeConnectionEvent, RealtimeSubscription, TypingEvent,
} from '@convokitapp/react-native'

export interface ConvoKitUiClient {
  readonly currentUserId: string
  readonly sessionIdentity: object | null
  getConversations(input: { limit: number; offset: number; archived: boolean }): Promise<Conversation[]>
  /** The 0.6 inbox: rooms in activity order with a preview and unread count per row, paged by cursor.
   * Optional so 0.5 adapters keep compiling; a list without it (or with a custom `pageLoader`) uses
   * `getConversations` and publishes no summaries. A 404 marks the endpoint unavailable for the store.
   */
  listInbox?(options: { limit: number; cursor: string | null; archived: boolean }): Promise<InboxPage>
  /** Message inserts/edits and read-position advances in the caller's rooms; never fires on join. */
  onInboxActivity?(handler: () => void): RealtimeSubscription
  getConversation(id: string): Promise<Conversation>
  getMessages(input: {
    conversationId: string; limit: number; offset?: number;
    beforeCreatedAt?: Date; beforeId?: string
  }): Promise<Message[]>
  getMessage(id: string): Promise<Message>
  sendMessage(input: {
    conversationId: string; clientMessageId?: string; text?: string; media?: MessageMedia[]
  }): Promise<Message>
  /** Acknowledge through `options.throughMessageId` (the newest rendered message). Adapters that ignore the
   * target degrade to acknowledging the newest message on the server at request time; a target the server
   * no longer knows must reject with an error whose `code` is `MESSAGE_NOT_FOUND`.
   */
  markConversationRead(id: string, options?: MarkConversationReadOptions): Promise<void>
  sendTyping(input: { conversationId: string; isTyping: boolean }): Promise<void>
  onConnectionEvent(handler: (event: RealtimeConnectionEvent) => void, ended: () => void): RealtimeSubscription
  onInboxChanged(handler: () => void): RealtimeSubscription
  onMessage(id: string, handler: (event: MessageEvent) => void): RealtimeSubscription
  onMessageDeleted(id: string, handler: (event: MessageDeletedEvent) => void): RealtimeSubscription
  onReadReceipt(id: string, handler: (event: ReadEvent) => void): RealtimeSubscription
  onTyping(id: string, handler: (event: TypingEvent) => void): RealtimeSubscription
}

export class DefaultConvoKitUiClient implements ConvoKitUiClient {
  constructor(readonly sdk: ConvoKitClient) {}
  get currentUserId(): string { return this.sdk.connected ? this.sdk.currentUserId : '' }
  get sessionIdentity(): object | null { return this.sdk.connected ? this.sdk.realtime : null }
  getConversations(input: { limit: number; offset: number; archived: boolean }) {
    return this.sdk.getConversations(input)
  }
  listInbox(options: { limit: number; cursor: string | null; archived: boolean }) { return this.sdk.listInbox(options) }
  getConversation(id: string) { return this.sdk.getConversation(id) }
  getMessages(input: Parameters<ConvoKitClient['getMessages']>[0]) { return this.sdk.getMessages(input) }
  getMessage(id: string) { return this.sdk.getMessage(id) }
  sendMessage(input: Parameters<ConvoKitClient['sendMessage']>[0]) { return this.sdk.sendMessage(input) }
  markConversationRead(id: string, options?: MarkConversationReadOptions) {
    return this.sdk.markConversationRead(id, options ?? {})
  }
  sendTyping(input: { conversationId: string; isTyping: boolean }) { return this.sdk.sendTyping(input) }
  onConnectionEvent(handler: (event: RealtimeConnectionEvent) => void, ended: () => void) {
    return this.sdk.realtime.onConnectionEvent({ onEvent: handler, onSessionEnded: ended })
  }
  onInboxChanged(handler: () => void) { return this.sdk.realtime.onInboxChanged(this.sdk.clientId, handler) }
  onInboxActivity(handler: () => void) { return this.sdk.realtime.onInboxActivity(this.sdk.clientId, handler) }
  onMessage(id: string, handler: (event: MessageEvent) => void) { return this.sdk.realtime.onMessage(id, handler) }
  onMessageDeleted(id: string, handler: (event: MessageDeletedEvent) => void) {
    return this.sdk.realtime.onMessageDeleted(id, handler)
  }
  onReadReceipt(id: string, handler: (event: ReadEvent) => void) {
    return this.sdk.realtime.onReadReceipt(id, handler)
  }
  onTyping(id: string, handler: (event: TypingEvent) => void) {
    return this.sdk.realtime.onTyping(id, handler)
  }
}
