import { describe, expect, it, vi } from 'vitest'
import type { Conversation, Message, RealtimeSubscription } from '@convokitapp/react-native'
import { ConversationController } from '../src/conversation-controller'
import { filterConversations } from '../src/filter'
import type { ConvoKitUiClient } from '../src/client'

vi.mock('@convokitapp/react-native', () => ({
  createClientMessageId: () => 'client-message-id',
}))

const conversation: Conversation = {
  id: 'room', appId: 'app', title: 'Launch', displayTitle: 'Launch room', description: 'Support handoff',
  imageUrl: null, participants: [], createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
}
const close = (): RealtimeSubscription => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })

function client(): ConvoKitUiClient {
  const session = {}
  return {
    currentUserId: 'me', sessionIdentity: session,
    getConversations: vi.fn().mockResolvedValue([conversation]),
    getConversation: vi.fn().mockResolvedValue(conversation),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn(),
    sendMessage: vi.fn(async input => ({
      id: 'message-1', conversationId: input.conversationId, senderId: 'me',
      clientMessageId: input.clientMessageId, text: input.text ?? null, media: input.media ?? [],
      createdAt: new Date(), updatedAt: null,
    } satisfies Message)),
    markConversationRead: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    onConnectionEvent: vi.fn(close), onInboxChanged: vi.fn(close), onMessage: vi.fn(close),
    onMessageDeleted: vi.fn(close), onReadReceipt: vi.fn(close), onTyping: vi.fn(close),
  }
}

describe('UI state', () => {
  it('filters locally by text and participant', () => {
    const row = { ...conversation, participants: [{
      id: 'p1', appUserId: 'alex', name: 'Alex', imageUrl: null, role: 'READ_WRITE' as const, lastReadAt: null,
    }] }
    expect(filterConversations([row], { query: 'support', participantIds: new Set(['alex']) })).toEqual([row])
    expect(filterConversations([row], { query: 'missing' })).toEqual([])
  })

  it('reconciles an optimistic message with the send response', async () => {
    const sdk = client()
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    const send = controller.sendMessage({ text: 'Hello' })
    expect(controller.getSnapshot().messages[0]?.id).toMatch(/^convokit-pending-/)
    await expect(send).resolves.toMatchObject({ id: 'message-1', text: 'Hello' })
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['message-1'])
    await controller.dispose()
  })
})
