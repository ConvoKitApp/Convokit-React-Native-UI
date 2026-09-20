import { describe, expect, it, vi } from 'vitest'
import type {
  Conversation, Message, MessageDeletedEvent, MessageEvent, Participant, ReadEvent, ReadPosition, RealtimeSubscription,
} from '@convokitapp/react-native'
import { ConversationController } from '../src/conversation-controller'
import { filterConversations } from '../src/filter'
import type { ConvoKitUiClient } from '../src/client'

// The React Native entry installs runtime polyfills, so the tests mock it with the shared
// read-position helpers the package re-exports from the core SDK.
vi.mock('@convokitapp/react-native', async () => {
  const { covers, readThrough } = await import('@convokitapp/sdk')
  return { createClientMessageId: () => 'client-message-id', covers, readThrough }
})

const participant = (appUserId: string, lastReadAt: Date | null = null, readPosition: ReadPosition | null = null): Participant => ({
  id: `p-${appUserId}`, appUserId, name: appUserId, imageUrl: null, role: 'READ_WRITE', lastReadAt, readPosition,
})
const conversation: Conversation = {
  id: 'room', appId: 'app', title: 'Launch', displayTitle: 'Launch room', description: 'Support handoff',
  imageUrl: null, participants: [], createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
}
const at = (seconds: number) => new Date(Date.UTC(2026, 7, 1, 11, 0, seconds))
const message = (id: string, senderId: string, createdAt: Date, text: string | null = `text ${id}`): Message => ({
  id, conversationId: 'room', senderId, clientMessageId: null, text, media: text ? [] : [{ type: 'image', url: `https://cdn/${id}` }],
  createdAt, updatedAt: null,
})
const position = (row: Message): ReadPosition => ({ messageId: row.id, createdAt: row.createdAt })
const close = (): RealtimeSubscription => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function client(rows: Message[] = [], participants: Participant[] = []) {
  const session = {}
  const handlers: {
    message?: (event: MessageEvent) => void
    deleted?: (event: MessageDeletedEvent) => void
    read?: (event: ReadEvent) => void
  } = {}
  const sdk: ConvoKitUiClient = {
    currentUserId: 'me', sessionIdentity: session,
    getConversations: vi.fn().mockResolvedValue([conversation]),
    getConversation: vi.fn(async () => ({ ...conversation, participants })),
    getMessages: vi.fn(async () => [...rows].reverse()),
    getMessage: vi.fn(async (id: string) => {
      const row = rows.find(candidate => candidate.id === id)
      if (!row) throw Object.assign(new Error('Message not found'), { status: 404 })
      return row
    }),
    sendMessage: vi.fn(async input => ({
      id: 'message-1', conversationId: input.conversationId, senderId: 'me',
      clientMessageId: input.clientMessageId, text: input.text ?? null, media: input.media ?? [],
      createdAt: new Date(), updatedAt: null,
    } satisfies Message)),
    markConversationRead: vi.fn().mockResolvedValue(undefined),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    onConnectionEvent: vi.fn(close), onInboxChanged: vi.fn(close),
    onMessage: vi.fn((_, handler) => { handlers.message = handler; return close() }),
    onMessageDeleted: vi.fn((_, handler) => { handlers.deleted = handler; return close() }),
    onReadReceipt: vi.fn((_, handler) => { handlers.read = handler; return close() }),
    onTyping: vi.fn(close),
  }
  const targets = () => vi.mocked(sdk.markConversationRead).mock.calls.map(([, options]) => options?.throughMessageId)
  const live = {
    async insert(row: Message, type: MessageEvent['type'] = 'insert') {
      const index = rows.findIndex(candidate => candidate.id === row.id)
      if (index === -1) rows.push(row); else rows[index] = row
      handlers.message!({ type, message: row }); await flush()
    },
    async remove(id: string) { handlers.deleted!({ id, conversationId: 'room' }); await flush() },
    read(userId: string, readAt: Date, readPosition: ReadPosition | null = null) { handlers.read!({ userId, readAt, readPosition }) },
  }
  return { sdk, targets, live, rows, participants }
}

describe('UI state', () => {
  it('filters locally by text and participant', () => {
    const row = { ...conversation, participants: [participant('alex')] }
    expect(filterConversations([row], { query: 'support', participantIds: new Set(['alex']) })).toEqual([row])
    expect(filterConversations([row], { query: 'missing' })).toEqual([])
  })

  it('reconciles an optimistic message with the send response', async () => {
    const { sdk } = client()
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    const send = controller.sendMessage({ text: 'Hello' })
    expect(controller.getSnapshot().messages[0]?.id).toMatch(/^convokit-pending-/)
    await expect(send).resolves.toMatchObject({ id: 'message-1', text: 'Hello' })
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['message-1'])
    await controller.dispose()
  })
})

describe('read receipts', () => {
  const [a, b, c] = [message('a', 'me', at(10)), message('b', 'me', at(10)), message('c', 'me', at(10))]
  const later = message('d', 'me', at(20))

  it('computes readers from read positions by (createdAt, id), breaking ties by id', async () => {
    const { sdk } = client([a, b, c, later], [participant('alex', at(30), position(b)), participant('sam', at(30), position(later))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    expect(controller.getSnapshot().readPositionByUserId.get('alex')).toEqual(position(b))
    expect([...controller.readerIdsFor(a)].sort()).toEqual(['alex', 'sam'])
    expect([...controller.readerIdsFor(b)].sort()).toEqual(['alex', 'sam'])
    expect([...controller.readerIdsFor(c)]).toEqual(['sam'])
    expect([...controller.readerIdsFor(later)]).toEqual(['sam'])
    await controller.dispose()
  })

  it('lets the position decide even when the acknowledgement time is later', async () => {
    const { sdk } = client([a, later], [participant('alex', at(30), position(a))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    expect(controller.readerIdsFor(a).has('alex')).toBe(true)
    expect(controller.readerIdsFor(later).has('alex')).toBe(false)
    await controller.dispose()
  })

  it('falls back to lastReadAt for a legacy participant without a position', async () => {
    const { sdk } = client([a, later], [participant('sam', at(15), null)])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    expect(controller.getSnapshot().readAtByUserId.get('sam')).toEqual(at(15))
    expect(controller.getSnapshot().readPositionByUserId.has('sam')).toBe(false)
    expect(controller.readerIdsFor(a).has('sam')).toBe(true)
    expect(controller.readerIdsFor(later).has('sam')).toBe(false)
    await controller.dispose()
  })

  it('excludes the sender and pending rows from readers', async () => {
    const { sdk } = client([a], [participant('me', at(30), position(later)), participant('alex', at(30), position(later))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    expect([...controller.readerIdsFor(a)]).toEqual(['alex'])
    expect(controller.readerIdsFor({ ...a, id: 'convokit-pending-1' }).size).toBe(0)
    await controller.dispose()
  })

  it('advances positions from read events monotonically and never regresses', async () => {
    const { sdk, live } = client([a, later], [participant('alex', at(11), position(a))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    live.read('alex', at(25), position(later))
    expect(controller.getSnapshot().readPositionByUserId.get('alex')).toEqual(position(later))
    expect(controller.readerIdsFor(later).has('alex')).toBe(true)
    live.read('alex', at(12), position(a))
    expect(controller.getSnapshot().readPositionByUserId.get('alex')).toEqual(position(later))
    expect(controller.getSnapshot().readAtByUserId.get('alex')).toEqual(at(25))
    expect(controller.readerIdsFor(later).has('alex')).toBe(true)
    live.read('alex', at(26), null)
    expect(controller.getSnapshot().readPositionByUserId.get('alex')).toEqual(position(later))
    expect(controller.getSnapshot().readAtByUserId.get('alex')).toEqual(at(26))
    await controller.dispose()
  })

  it('merges participant reads on refresh without moving a position backward', async () => {
    const { sdk, live } = client([a, later], [participant('alex', at(11), position(a))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    live.read('alex', at(25), position(later))
    await controller.refresh()
    expect(controller.getSnapshot().readPositionByUserId.get('alex')).toEqual(position(later))
    expect(controller.getSnapshot().readAtByUserId.get('alex')).toEqual(at(25))
    expect(controller.readerIdsFor(later).has('alex')).toBe(true)
    await controller.dispose()
  })

  it('never fabricates the local user\'s own read', async () => {
    const { sdk, targets } = client([message('m1', 'alex', at(10))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(targets()).toEqual(['m1'])
    expect(controller.getSnapshot().readAtByUserId.has('me')).toBe(false)
    expect(controller.getSnapshot().readPositionByUserId.has('me')).toBe(false)
    await controller.dispose()
  })
})

describe('acknowledgements', () => {
  const notFound = () => Object.assign(new Error('Message not found'), { status: 404, code: 'MESSAGE_NOT_FOUND' })

  it('acknowledges the newest rendered row on load and after foreign inserts', async () => {
    const { sdk, targets, live } = client([message('m1', 'alex', at(10))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(vi.mocked(sdk.markConversationRead)).toHaveBeenCalledWith('room', { throughMessageId: 'm1' })
    await live.insert(message('m2', 'alex', at(20)))
    expect(targets()).toEqual(['m1', 'm2'])
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  it('sends the newest rendered row at send time and coalesces follow-ups', async () => {
    const { sdk, targets, live } = client([message('m1', 'alex', at(10))])
    const first = deferred()
    vi.mocked(sdk.markConversationRead).mockReturnValueOnce(first.promise)
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    const load = controller.loadInitial()
    await flush()
    expect(targets()).toEqual(['m1'])
    await live.insert(message('m2', 'alex', at(20)))
    await live.insert(message('m3', 'alex', at(30)))
    expect(targets()).toEqual(['m1'])
    first.resolve()
    await load
    expect(targets()).toEqual(['m1', 'm3'])
    await controller.markRead()
    expect(targets()).toEqual(['m1', 'm3'])
    await controller.dispose()
  })

  it('does not acknowledge a media-only row until it is hydrated', async () => {
    const { sdk, targets, live } = client()
    const hydration = deferred<Message>()
    vi.mocked(sdk.getMessage).mockReturnValueOnce(hydration.promise)
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    const row = message('m1', 'alex', at(10), null)
    await live.insert(row)
    expect(controller.getSnapshot().messages).toEqual([])
    expect(targets()).toEqual([])
    hydration.resolve({ ...row, media: [{ type: 'image', url: 'https://cdn/m1', name: 'photo.png' }] })
    await flush()
    expect(controller.getSnapshot().messages.map(candidate => candidate.id)).toEqual(['m1'])
    expect(targets()).toEqual(['m1'])
    await controller.dispose()
  })

  it('never targets a pending row', async () => {
    const { sdk, targets, live } = client()
    const send = deferred<Message>()
    vi.mocked(sdk.sendMessage).mockReturnValueOnce(send.promise)
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    const sending = controller.sendMessage({ text: 'Hello' })
    await controller.markRead()
    expect(targets()).toEqual([])
    await live.insert(message('m1', 'alex', at(10)))
    expect(targets()).toEqual(['m1'])
    send.resolve(message('m2', 'me', at(20)))
    await sending
    await controller.dispose()
  })

  it('ignores update events and re-delivered known rows', async () => {
    const original = message('m1', 'alex', at(10))
    const { sdk, targets, live } = client([original])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    await live.insert({ ...original, text: 'edited', updatedAt: at(11) }, 'update')
    await live.insert(original, 'insert')
    expect(controller.getSnapshot().messages[0]?.text).toBe('edited')
    expect(targets()).toEqual([])
    await controller.dispose()
  })

  it('defers acknowledgements while hidden and re-issues only a suppressed one', async () => {
    const { sdk, targets, live } = client()
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    controller.setVisible(false)
    await live.insert(message('m1', 'alex', at(10)))
    await live.insert(message('m2', 'alex', at(20)))
    expect(targets()).toEqual([])
    controller.setVisible(true)
    await flush()
    expect(targets()).toEqual(['m2'])
    controller.setVisible(false); controller.setVisible(true)
    await flush()
    expect(targets()).toEqual(['m2'])
    await controller.dispose()
  })

  it('sends nothing when both automatic triggers are off, including on visibility changes', async () => {
    const { sdk, targets, live } = client([message('m1', 'alex', at(10))])
    const controller = new ConversationController({
      conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false, markReadOnReceive: false,
    })
    await controller.loadInitial()
    await live.insert(message('m2', 'alex', at(20), null))
    controller.setVisible(false); controller.setVisible(true)
    await live.remove('m2')
    await controller.refresh()
    await flush()
    expect(targets()).toEqual([])
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  it('retries once with the next newest row when the server does not know the target', async () => {
    const { sdk, targets } = client([message('m1', 'alex', at(10)), message('m2', 'alex', at(20))])
    vi.mocked(sdk.markConversationRead).mockRejectedValueOnce(notFound())
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(targets()).toEqual(['m2', 'm1'])
    expect(controller.getSnapshot().error).toBeNull()
    await controller.markRead()
    expect(targets()).toEqual(['m2', 'm1'])
    await controller.dispose()
  })

  it('stops after every rendered row has been refused', async () => {
    const { sdk, targets } = client([message('m1', 'alex', at(10)), message('m2', 'alex', at(20))])
    vi.mocked(sdk.markConversationRead).mockRejectedValue(notFound())
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(targets()).toEqual(['m2', 'm1'])
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  // m4 and m5 arrive, m5 is deleted while its acknowledgement is in flight and the server still
  // answers 204: the deletion alone must discard m5 as the acknowledged target and re-issue for m4.
  it('acknowledges m4 when m5 is deleted before its acknowledgement completes', async () => {
    const { sdk, targets, live } = client()
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    controller.setVisible(false)
    await live.insert(message('m4', 'alex', at(40)))
    await live.insert(message('m5', 'alex', at(50)))
    const pending = deferred()
    vi.mocked(sdk.markConversationRead).mockReturnValueOnce(pending.promise)
    controller.setVisible(true)
    await flush()
    expect(targets()).toEqual(['m5'])
    await live.remove('m5')
    expect(targets()).toEqual(['m5'])
    pending.resolve()
    await flush()
    expect(targets()).toEqual(['m5', 'm4'])
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['m4'])
    expect(controller.getSnapshot().error).toBeNull()
    // m4 is now the acknowledged target, so nothing at or before it is re-sent.
    await controller.markRead()
    expect(targets()).toEqual(['m5', 'm4'])
    await controller.dispose()
  })

  it('re-issues only once when the deleted in-flight target is also refused by the server', async () => {
    const { sdk, targets, live } = client([message('m4', 'alex', at(40)), message('m5', 'alex', at(50))])
    const pending = deferred()
    vi.mocked(sdk.markConversationRead).mockReturnValueOnce(pending.promise)
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    const load = controller.loadInitial()
    await flush()
    expect(targets()).toEqual(['m5'])
    await live.remove('m5')
    pending.reject(notFound())
    await load
    expect(targets()).toEqual(['m5', 'm4'])
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  it('re-resolves once when the last acknowledged row is deleted', async () => {
    const { sdk, targets, live } = client([message('m1', 'alex', at(10)), message('m2', 'alex', at(20))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(targets()).toEqual(['m2'])
    await live.remove('m2')
    expect(targets()).toEqual(['m2', 'm1'])
    await live.remove('m1')
    expect(targets()).toEqual(['m2', 'm1'])
    await controller.dispose()
  })

  it('drops a row whose hydration reports it deleted', async () => {
    const { sdk, targets, live } = client()
    vi.mocked(sdk.getMessage).mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }))
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    await live.insert(message('m1', 'alex', at(10)))
    expect(controller.getSnapshot().messages).toEqual([])
    expect(targets()).toEqual([])
    await controller.dispose()
  })

  it('still surfaces a membership failure as an error', async () => {
    const { sdk, targets } = client([message('m1', 'alex', at(10))])
    const failure = Object.assign(new Error('Conversation not found'), { status: 404 })
    vi.mocked(sdk.markConversationRead).mockRejectedValueOnce(failure)
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(targets()).toEqual(['m1'])
    expect(controller.getSnapshot().error).toBe(failure)
    await controller.dispose()
  })
})
