import type {
  ClearConversationUnreadOptions, ClearUnreadResult, ConversationPrivateState, ConvoKitClient, Conversation, InboxPage,
  MarkConversationReadOptions, Message, MessageContextPage, MessageDeletedEvent, MessageEvent, MessageMedia, ReadEvent,
  RealtimeConnectionEvent, RealtimeSubscription, ReplyPreview, TypingEvent,
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
  /** Since 0.9 the input may carry `replyToMessageId`, the message in the same room the send quotes. It
   * is omitted entirely when the composer has no reply target, so a send without a quote is byte-identical
   * to 0.8; a target that is not in this conversation must reject with `code` `MESSAGE_NOT_FOUND`. Adapters
   * written against the 0.8 signature still satisfy this one.
   */
  sendMessage(input: {
    conversationId: string; clientMessageId?: string; text?: string; media?: MessageMedia[]
    replyToMessageId?: string
  }): Promise<Message>
  /** Acknowledge through `options.throughMessageId` (the newest rendered message). Adapters that ignore the
   * target degrade to acknowledging the newest message on the server at request time; a target the server
   * no longer knows must reject with an error whose `code` is `MESSAGE_NOT_FOUND`. Since 0.7 the options
   * may also carry `privateStateVersion`, the version captured when the room opened; forward the options
   * unchanged, or the caller's unread marker is never cleared by an acknowledgement.
   */
  markConversationRead(id: string, options?: MarkConversationReadOptions): Promise<void>
  /** The 0.7 private marker: flag the room unread for the caller only. Optional so 0.6 adapters keep
   * compiling; `ConversationListController.markUnread` rejects without it.
   */
  markConversationUnread?(id: string): Promise<ConversationPrivateState>
  /** Remove the caller's marker; with `ifVersion` only while it still has that version (`cleared: false`
   * otherwise, never an error). Optional; `ConversationListController.clearUnread` rejects without it and a
   * room controller opened on a marked, empty room leaves the marker in place.
   */
  clearConversationUnread?(id: string, options?: ClearConversationUnreadOptions): Promise<ClearUnreadResult>
  /** The 0.8 author edit: replace the text of one of the caller's own messages, or clear the caption of a
   * message with attachments with `text: null`; both keys are always sent. `revision` is the row's
   * `Message.revision` as the user saw it, and a stale one must reject with an error whose `code` is
   * `REVISION_CONFLICT` (status 409); a message the server no longer knows with `code` `MESSAGE_NOT_FOUND`.
   * Optional so 0.7 adapters keep compiling: without it the room controller reports
   * `canEditMessages: false`, renders no edit action and `saveEdit` rejects.
   */
  editMessage?(messageId: string, input: { text: string | null; revision: number }): Promise<Message>
  /** The 0.8 author delete of one of the caller's own messages. A message that is already gone must reject
   * with `code` `MESSAGE_NOT_FOUND`. Optional; without it `canDeleteMessages` is false and `deleteMessage`
   * rejects.
   */
  deleteMessage?(messageId: string): Promise<void>
  /** The 0.9 batch preview read: resolve the quoted parents of the replies on screen in one round trip.
   * Pass every distinct `Message.replyToMessageId` the window renders; the SDK trims, de-duplicates and
   * chunks at 50 per request. An id missing from a RESOLVED result is the only deletion signal — the
   * quoted message is gone or was never in this room — and is never an error. Optional so 0.8 adapters
   * keep compiling: without it the room controller reports `canResolveReplyPreviews: false` and renders
   * every quoted block without its text.
   */
  getReplyPreviews?(conversationId: string, messageIds: string[]): Promise<ReplyPreview[]>
  /** The 0.9 context window: one page of a room's history centred on `messageId`, or continued from a
   * previous window's `olderCursor` / `newerCursor`. Exactly one of the three selectors is sent. An
   * unknown, deleted or out-of-room `messageId` must reject with `code` `MESSAGE_NOT_FOUND`. Optional so
   * 0.8 adapters keep compiling: without it `canJumpToMessages` is false, no jump affordance renders and
   * `jumpToMessage` only highlights rows already in the window.
   */
  getMessageContext?(conversationId: string, options: {
    messageId?: string; olderCursor?: string; newerCursor?: string; limit?: number
  }): Promise<MessageContextPage>
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
  markConversationUnread(id: string) { return this.sdk.markConversationUnread(id) }
  clearConversationUnread(id: string, options?: ClearConversationUnreadOptions) {
    return this.sdk.clearConversationUnread(id, options ?? {})
  }
  editMessage(messageId: string, input: { text: string | null; revision: number }) {
    return this.sdk.editMessage(messageId, input)
  }
  deleteMessage(messageId: string) { return this.sdk.deleteMessage(messageId) }
  getReplyPreviews(conversationId: string, messageIds: string[]) {
    return this.sdk.getReplyPreviews(conversationId, messageIds)
  }
  getMessageContext(conversationId: string, options: Parameters<ConvoKitClient['getMessageContext']>[1]) {
    return this.sdk.getMessageContext(conversationId, options)
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
