import type {
  ConvoKitClient, Conversation, Message, MessageDeletedEvent, MessageEvent,
  MessageMedia, ReadEvent, RealtimeConnectionEvent, RealtimeSubscription, TypingEvent,
} from '@convokitapp/react-native'

export interface ConvoKitUiClient {
  readonly currentUserId: string
  readonly sessionIdentity: object | null
  getConversations(input: { limit: number; offset: number; archived: boolean }): Promise<Conversation[]>
  getConversation(id: string): Promise<Conversation>
  getMessages(input: {
    conversationId: string; limit: number; offset?: number;
    beforeCreatedAt?: Date; beforeId?: string
  }): Promise<Message[]>
  getMessage(id: string): Promise<Message>
  sendMessage(input: {
    conversationId: string; clientMessageId?: string; text?: string; media?: MessageMedia[]
  }): Promise<Message>
  markConversationRead(id: string): Promise<void>
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
  getConversation(id: string) { return this.sdk.getConversation(id) }
  getMessages(input: Parameters<ConvoKitClient['getMessages']>[0]) { return this.sdk.getMessages(input) }
  getMessage(id: string) { return this.sdk.getMessage(id) }
  sendMessage(input: Parameters<ConvoKitClient['sendMessage']>[0]) { return this.sdk.sendMessage(input) }
  markConversationRead(id: string) { return this.sdk.markConversationRead(id) }
  sendTyping(input: { conversationId: string; isTyping: boolean }) { return this.sdk.sendTyping(input) }
  onConnectionEvent(handler: (event: RealtimeConnectionEvent) => void, ended: () => void) {
    return this.sdk.realtime.onConnectionEvent({ onEvent: handler, onSessionEnded: ended })
  }
  onInboxChanged(handler: () => void) { return this.sdk.realtime.onInboxChanged(this.sdk.clientId, handler) }
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
