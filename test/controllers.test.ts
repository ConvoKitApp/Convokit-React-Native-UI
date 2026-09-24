import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClearConversationUnreadOptions, ClearUnreadResult, Conversation, ConversationMembership, ConversationPrivateState,
  InboxEntry, InboxPage, InboxSummary, Message, MessageDeletedEvent, MessageEvent, Participant, ReadEvent, ReadPosition,
  ReactionChangedEvent, RealtimeSubscription,
} from '@convokitapp/react-native'
import { ConversationController } from '../src/conversation-controller'
import { ConversationListController } from '../src/conversation-list-controller'
import { filterConversations } from '../src/filter'
import { mergeInboxEntries } from '../src/inbox'
import type { ConvoKitUiClient } from '../src/client'
import type { EditMessageInput, InboxSummary as ExportedInboxSummary } from '../src'

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
  createdAt, updatedAt: null, revision: 0,
})
const position = (row: Message): ReadPosition => ({ messageId: row.id, createdAt: row.createdAt })
/** The caller's own row as a 0.7 backend serves it beside the conversation; marked when `unreadMarkedAt` is set. */
const membership = (privateStateVersion: number, unreadMarkedAt: Date | null = null): ConversationMembership => ({
  role: 'READ_WRITE', lastReadAt: null, readPosition: null, unreadMarkedAt, privateStateVersion,
})
const close = (): RealtimeSubscription => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const conflict = () => Object.assign(new Error('Message was changed since it was loaded'), { status: 409, code: 'REVISION_CONFLICT' })
const missing = () => Object.assign(new Error('Message not found'), { status: 404, code: 'MESSAGE_NOT_FOUND' })

/** `membership` makes `getConversation` answer like a 0.7 backend; `unread: false` builds a 0.6 adapter without
 * the optional mark/clear members; `edits: false` a 0.7 adapter without the author edit/delete members. The
 * 0.8 members act on `rows` like the backend: a stale revision is a 409, an unknown id a coded 404.
 */
function client(rows: Message[] = [], participants: Participant[] = [], options: { membership?: ConversationMembership; unread?: boolean; edits?: boolean; reactions?: boolean } = {}) {
  const session = {}
  const handlers: {
    message?: (event: MessageEvent) => void
    deleted?: (event: MessageDeletedEvent) => void
    read?: (event: ReadEvent) => void
    inboxChanged?: () => void
    reaction?: (event: ReactionChangedEvent) => void
  } = {}
  const reactions = new Map<string, Set<string>>()
  const sdk: ConvoKitUiClient = {
    currentUserId: 'me', sessionIdentity: session,
    getConversations: vi.fn().mockResolvedValue([conversation]),
    getConversation: vi.fn(async () => ({ ...conversation, participants, ...(options.membership ? { membership: options.membership } : {}) })),
    getMessages: vi.fn(async () => [...rows].reverse()),
    getMessage: vi.fn(async (id: string) => {
      const row = rows.find(candidate => candidate.id === id)
      if (!row) throw Object.assign(new Error('Message not found'), { status: 404 })
      return row
    }),
    sendMessage: vi.fn(async input => ({
      id: 'message-1', conversationId: input.conversationId, senderId: 'me',
      clientMessageId: input.clientMessageId, text: input.text ?? null, media: input.media ?? [],
      createdAt: new Date(), updatedAt: null, revision: 0,
    } satisfies Message)),
    markConversationRead: vi.fn().mockResolvedValue(undefined),
    ...(options.unread === false ? {} : {
      markConversationUnread: vi.fn(async (id: string): Promise<ConversationPrivateState> =>
        ({ conversationId: id, unreadMarkedAt: at(60), privateStateVersion: 1 })),
      clearConversationUnread: vi.fn(async (id: string, clear?: ClearConversationUnreadOptions): Promise<ClearUnreadResult> =>
        ({ conversationId: id, cleared: true, unreadMarkedAt: null, privateStateVersion: (clear?.ifVersion ?? 0) + 1 })),
    }),
    ...(options.edits === false ? {} : {
      editMessage: vi.fn(async (id: string, input: { text: string | null; revision: number }): Promise<Message> => {
        const index = rows.findIndex(candidate => candidate.id === id)
        const row = rows[index]
        if (!row) throw missing()
        if (row.revision !== input.revision) throw conflict()
        const next = { ...row, text: input.text, revision: row.revision + 1, updatedAt: at(50 + row.revision) }
        rows[index] = next
        return next
      }),
      deleteMessage: vi.fn(async (id: string): Promise<void> => {
        const index = rows.findIndex(candidate => candidate.id === id)
        if (index === -1) throw missing()
        rows.splice(index, 1)
      }),
    }),
    ...(options.reactions ? {
      getReactionSummaries: vi.fn(async (_room: string, ids: string[]) => ids.map(messageId => ({
        messageId, reactions: [...(reactions.get(messageId) ?? [])].map(emoji => ({ emoji, count: 1, reactedByMe: true })), hasMore: false,
      }))),
      addReaction: vi.fn(async (messageId: string, emoji: string) => {
        const set = reactions.get(messageId) ?? new Set<string>(); const changed = !set.has(emoji)
        set.add(emoji); reactions.set(messageId, set); return { messageId, emoji, changed }
      }),
      removeReaction: vi.fn(async (messageId: string, emoji: string) => ({ messageId, emoji, changed: reactions.get(messageId)?.delete(emoji) ?? false })),
      listReactionUsers: vi.fn(async () => ({ data: [], nextCursor: null })),
      onReactionChanged: vi.fn((_id: string, handler: (event: ReactionChangedEvent) => void) => { handlers.reaction = handler; return close() }),
    } : {}),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    onConnectionEvent: vi.fn(close),
    onInboxChanged: vi.fn(handler => { handlers.inboxChanged = handler; return close() }),
    onMessage: vi.fn((_, handler) => { handlers.message = handler; return close() }),
    onMessageDeleted: vi.fn((_, handler) => { handlers.deleted = handler; return close() }),
    onReadReceipt: vi.fn((_, handler) => { handlers.read = handler; return close() }),
    onTyping: vi.fn(close),
  }
  const targets = () => vi.mocked(sdk.markConversationRead).mock.calls.map(([, options]) => options?.throughMessageId)
  /** Every acknowledgement body as sent, so a version (or its absence) is pinned exactly. */
  const acks = () => vi.mocked(sdk.markConversationRead).mock.calls.map(([, options]) => options)
  const clears = () => vi.mocked(sdk.clearConversationUnread!).mock.calls
  const live = {
    async insert(row: Message, type: MessageEvent['type'] = 'insert') {
      const index = rows.findIndex(candidate => candidate.id === row.id)
      if (index === -1) rows.push(row); else rows[index] = row
      handlers.message!({ type, message: row }); await flush()
    },
    async remove(id: string) { handlers.deleted!({ id, conversationId: 'room' }); await flush() },
    read(userId: string, readAt: Date, readPosition: ReadPosition | null = null) { handlers.read!({ userId, readAt, readPosition }) },
    /** An `inbox_changed` signal for the bound user; the refresh it queues has settled once this resolves. */
    async inboxChanged() { handlers.inboxChanged?.(); await flush() },
    reactionChanged(id: string, conversationId = 'room') { handlers.reaction?.({ id, conversationId }) },
    setReaction(id: string, emoji: string) { reactions.set(id, new Set([emoji])) },
  }
  return { sdk, targets, acks, clears, live, rows, participants }
}

describe('UI state', () => {
  it('refreshes visible reaction summaries on private invalidations and toggles the exact emoji', async () => {
    vi.useFakeTimers()
    try {
      const row = message('reaction-row', 'alex', at(1))
      const { sdk, live } = client([row], [participant('me'), participant('alex')], { reactions: true })
      const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
      await controller.loadInitial()
      await vi.advanceTimersByTimeAsync(30)
      expect(controller.getSnapshot().canReact).toBe(true)
      expect(sdk.getReactionSummaries).toHaveBeenCalledWith('room', ['reaction-row'])
      live.setReaction(row.id, '👍🏽')
      live.reactionChanged(row.id, 'other-room')
      await vi.advanceTimersByTimeAsync(30)
      expect(controller.getSnapshot().reactionSummaries.get(row.id)?.reactions).toEqual([])
      live.reactionChanged(row.id)
      await vi.advanceTimersByTimeAsync(30)
      expect(controller.getSnapshot().reactionSummaries.get(row.id)?.reactions[0]).toEqual({ emoji: '👍🏽', count: 1, reactedByMe: true })
      expect(await controller.toggleReaction(row.id, '👍🏽')).toBe(true)
      await vi.advanceTimersByTimeAsync(30)
      expect(controller.getSnapshot().reactionSummaries.get(row.id)?.reactions).toEqual([])
      await controller.dispose()
    } finally { vi.useRealTimers() }
  })
  it('re-exports the core types the UI surface is typed against', () => {
    const input: EditMessageInput = { text: null, revision: 2 }
    const inbox: ExportedInboxSummary = {
      latestMessage: null, unreadCount: 0, unreadCountCapped: false, readPosition: null, lastReadAt: null,
      unreadMarkedAt: null, privateStateVersion: 0, activityAt: at(0), isUnread: false,
    }
    expect(input.revision).toBe(2)
    expect(inbox satisfies InboxSummary).toMatchObject({ isUnread: false })
  })

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

  // A deletion re-targets only where the next row's arrival would have been acknowledged anyway: a room
  // that opted out of receive acknowledgements never sends one because a deletion arrived.
  it('does not re-target an acknowledgement for a deletion when markReadOnReceive is off', async () => {
    const { sdk, targets, live } = client([message('m1', 'alex', at(10)), message('m2', 'alex', at(20))])
    const controller = new ConversationController({
      conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: true, markReadOnReceive: false,
    })
    await controller.loadInitial()
    expect(targets()).toEqual(['m2'])
    await live.insert(message('m4', 'alex', at(40)))
    await live.remove('m2')
    await flush()
    expect(targets()).toEqual(['m2'])
    expect(controller.getSnapshot().error).toBeNull()
    // An explicit acknowledgement still resolves the newest rendered row.
    await controller.markRead()
    expect(targets()).toEqual(['m2', 'm4'])
    // The in-flight target deleted under the same option: no follow-up either.
    const pending = deferred()
    vi.mocked(sdk.markConversationRead).mockReturnValueOnce(pending.promise)
    await live.insert(message('m5', 'alex', at(50)))
    const explicit = controller.markRead()
    await flush()
    expect(targets()).toEqual(['m2', 'm4', 'm5'])
    await live.remove('m5')
    pending.resolve()
    await explicit
    await flush()
    expect(targets()).toEqual(['m2', 'm4', 'm5'])
    expect(vi.mocked(sdk.markConversationRead)).toHaveBeenCalledTimes(3)
    await controller.dispose()
  })
})

describe('room reconciliation', () => {
  it('reconciles the room on inbox_changed and drops the subscription on dispose', async () => {
    const { sdk, live, rows } = client([message('m1', 'alex', at(10))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    expect(sdk.onInboxChanged).not.toHaveBeenCalled()
    await controller.loadInitial()
    expect(sdk.onInboxChanged).toHaveBeenCalledTimes(1)
    expect(sdk.getMessages).toHaveBeenCalledTimes(1)
    rows.push(message('m2', 'alex', at(20)))
    await live.inboxChanged()
    expect(sdk.getMessages).toHaveBeenCalledTimes(2)
    expect(sdk.getConversation).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['m1', 'm2'])
    expect(controller.getSnapshot()).toMatchObject({ isReconciling: false, error: null })
    // A burst during a reconcile is coalesced: one refresh in flight, one queued behind it.
    const page = deferred<Message[]>()
    vi.mocked(sdk.getMessages).mockReturnValueOnce(page.promise)
    await live.inboxChanged(); await live.inboxChanged(); await live.inboxChanged()
    expect(sdk.getMessages).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot().isReconciling).toBe(true)
    page.resolve([...rows].reverse())
    await flush()
    expect(sdk.getMessages).toHaveBeenCalledTimes(4)
    expect(controller.getSnapshot()).toMatchObject({ isReconciling: false, error: null })
    const subscription = vi.mocked(sdk.onInboxChanged).mock.results[0]!.value as RealtimeSubscription
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    await controller.dispose()
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
    await live.inboxChanged()
    expect(sdk.getMessages).toHaveBeenCalledTimes(4)
  })

  // The SDK replays SUBSCRIBED (and so `inbox_changed`) synchronously to a listener joining an app hub the
  // list already holds: the signal lands inside the load that binds it and must run once after it.
  it('runs a signal delivered while binding as one refresh after the load, never a reload', async () => {
    const { sdk, rows } = client([message('m1', 'alex', at(10))])
    vi.mocked(sdk.onInboxChanged).mockImplementationOnce(handler => { handler(); return close() })
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    rows.push(message('m2', 'alex', at(20)))
    await controller.loadInitial()
    await flush()
    expect(sdk.onInboxChanged).toHaveBeenCalledTimes(1)
    expect(sdk.onMessage).toHaveBeenCalledTimes(1)
    expect(sdk.getMessages).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot()).toMatchObject({ hasLoaded: true, isInitialLoading: false, isReconciling: false, error: null })
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['m1', 'm2'])
    await controller.dispose()
  })

  it('still reconciles on the room rejoin, queued behind a reconcile in flight', async () => {
    const { sdk, rows } = client([message('m1', 'alex', at(10))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    const connection = vi.mocked(sdk.onConnectionEvent).mock.calls[0]![0]
    const page = deferred<Message[]>()
    vi.mocked(sdk.getMessages).mockReturnValueOnce(page.promise)
    connection({ topic: 'messages:room', status: 'SUBSCRIBED' })
    connection({ topic: 'conversation:room', status: 'SUBSCRIBED' })
    connection({ topic: 'messages:other', status: 'SUBSCRIBED' })
    await flush()
    expect(sdk.getMessages).toHaveBeenCalledTimes(2)
    rows.push(message('m2', 'alex', at(20)))
    page.resolve([message('m1', 'alex', at(10))])
    await flush()
    expect(sdk.getMessages).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['m1', 'm2'])
    await controller.dispose()
  })

  it('re-subscribes to inbox_changed with the other room subscriptions on the next loadInitial', async () => {
    const { sdk } = client([message('m1', 'alex', at(10))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    await controller.loadInitial()
    expect(sdk.onInboxChanged).toHaveBeenCalledTimes(2)
    const first = vi.mocked(sdk.onInboxChanged).mock.results[0]!.value as RealtimeSubscription
    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    await controller.dispose()
  })
})

describe('private unread marker', () => {
  const marked = (version: number) => membership(version, at(0))

  it('captures the version at open and sends it with every targeted acknowledgement of that open', async () => {
    const { sdk, acks, live } = client([message('m1', 'alex', at(10))], [], { membership: membership(7) })
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(acks()).toEqual([{ throughMessageId: 'm1', privateStateVersion: 7 }])
    // Another device marked the room since; the refresh learns version 9 but this open keeps sending 7.
    vi.mocked(sdk.getConversation).mockResolvedValue({ ...conversation, membership: marked(9) })
    await controller.refresh()
    expect(controller.getSnapshot().conversation?.membership?.privateStateVersion).toBe(9)
    await live.insert(message('m2', 'alex', at(20)))
    await controller.markRead()
    expect(acks()).toEqual([
      { throughMessageId: 'm1', privateStateVersion: 7 }, { throughMessageId: 'm2', privateStateVersion: 7 },
    ])
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  it('sends no version for a 0.6 conversation without a membership', async () => {
    const { sdk, acks, live } = client([message('m1', 'alex', at(10))])
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    await live.insert(message('m2', 'alex', at(20)))
    expect(acks()).toEqual([{ throughMessageId: 'm1' }, { throughMessageId: 'm2' }])
    expect(acks().some(body => body && 'privateStateVersion' in body)).toBe(false)
    await controller.dispose()
  })

  it('captures once from the reconcile that follows a transient first-load failure', async () => {
    const { sdk, acks, rows } = client([message('m1', 'alex', at(10))], [], { membership: membership(7) })
    vi.mocked(sdk.getConversation).mockRejectedValueOnce(new Error('offline'))
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(controller.getSnapshot()).toMatchObject({ conversation: null, hasLoaded: true })
    expect(acks()).toEqual([])
    await controller.refresh()
    expect(controller.getSnapshot().conversation?.membership?.privateStateVersion).toBe(7)
    await controller.markRead()
    expect(acks()).toEqual([{ throughMessageId: 'm1', privateStateVersion: 7 }])
    // A later reconcile of the same open never recaptures.
    vi.mocked(sdk.getConversation).mockResolvedValue({ ...conversation, membership: marked(9) })
    rows.push(message('m2', 'alex', at(20)))
    await controller.refresh()
    await controller.markRead()
    expect(acks()).toEqual([
      { throughMessageId: 'm1', privateStateVersion: 7 }, { throughMessageId: 'm2', privateStateVersion: 7 },
    ])
    await controller.dispose()
  })

  it('recaptures on the next loadInitial and after a session end', async () => {
    const { sdk, acks } = client([message('m1', 'alex', at(10))], [], { membership: membership(7) })
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    vi.mocked(sdk.getConversation).mockResolvedValue({ ...conversation, membership: marked(9) })
    await controller.loadInitial()
    expect(acks()).toEqual([
      { throughMessageId: 'm1', privateStateVersion: 7 }, { throughMessageId: 'm1', privateStateVersion: 9 },
    ])
    await controller.dispose()
  })

  it('clears the marker of an opened empty room once, conditionally on the captured version', async () => {
    const { sdk, acks, clears } = client([], [], { membership: marked(7) })
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    await controller.loadInitial()
    expect(clears()).toEqual([['room', { ifVersion: 7 }]])
    expect(acks()).toEqual([])
    await controller.markRead()
    await controller.refresh()
    controller.setVisible(false); controller.setVisible(true)
    await flush()
    expect(clears()).toHaveLength(1)
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  it('defers the empty-room clear while hidden and issues it on visibility', async () => {
    const { sdk, clears } = client([], [], { membership: marked(7) })
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    controller.setVisible(false)
    await controller.loadInitial()
    expect(clears()).toEqual([])
    controller.setVisible(true)
    await flush()
    expect(clears()).toEqual([['room', { ifVersion: 7 }]])
    await controller.dispose()
  })

  it('sends no clear while markReadOnLoad is off until an explicit markRead()', async () => {
    const { sdk, clears } = client([], [], { membership: marked(7) })
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    controller.setVisible(false); controller.setVisible(true)
    await flush()
    expect(clears()).toEqual([])
    await controller.markRead()
    expect(clears()).toEqual([['room', { ifVersion: 7 }]])
    await controller.markRead()
    expect(clears()).toHaveLength(1)
    await controller.dispose()
  })

  it('never clears through the adapter once a row was rendered or when nothing was marked', async () => {
    const withRows = client([message('m1', 'alex', at(10))], [], { membership: marked(7) })
    const rendered = new ConversationController({ conversationId: 'room', client: withRows.sdk, autoLoad: false })
    await rendered.loadInitial()
    expect(withRows.acks()).toEqual([{ throughMessageId: 'm1', privateStateVersion: 7 }])
    // The room empties again: the targeted acknowledgement already carried the version, so no clear follows.
    await withRows.live.remove('m1')
    await rendered.markRead()
    expect(rendered.getSnapshot().messages).toEqual([])
    expect(withRows.clears()).toEqual([])
    const unmarked = client([], [], { membership: membership(7) })
    const empty = new ConversationController({ conversationId: 'room', client: unmarked.sdk, autoLoad: false })
    await empty.loadInitial()
    await empty.markRead()
    expect(unmarked.clears()).toEqual([])
    expect(unmarked.acks()).toEqual([])
    const legacy = client()
    const older = new ConversationController({ conversationId: 'room', client: legacy.sdk, autoLoad: false })
    await older.loadInitial()
    expect(legacy.clears()).toEqual([])
    await rendered.dispose(); await empty.dispose(); await older.dispose()
  })

  it('acknowledges a row that arrives during the clear and treats cleared: false as success', async () => {
    const { sdk, acks, clears, live } = client([], [], { membership: marked(7) })
    const pending = deferred<ClearUnreadResult>()
    vi.mocked(sdk.clearConversationUnread!).mockReturnValueOnce(pending.promise)
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false })
    const load = controller.loadInitial()
    await flush()
    expect(clears()).toEqual([['room', { ifVersion: 7 }]])
    await live.insert(message('m1', 'alex', at(10)))
    expect(acks()).toEqual([])
    pending.resolve({ conversationId: 'room', cleared: false, unreadMarkedAt: at(5), privateStateVersion: 8 })
    await load
    expect(acks()).toEqual([{ throughMessageId: 'm1', privateStateVersion: 7 }])
    expect(clears()).toHaveLength(1)
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  it('surfaces a failed clear through error and skips the clear for an adapter without the member', async () => {
    const failing = client([], [], { membership: marked(7) })
    const failure = Object.assign(new Error('Conversation not found'), { status: 404 })
    vi.mocked(failing.sdk.clearConversationUnread!).mockRejectedValueOnce(failure)
    const controller = new ConversationController({ conversationId: 'room', client: failing.sdk, autoLoad: false })
    await controller.loadInitial()
    expect(controller.getSnapshot().error).toBe(failure)
    const legacy = client([], [], { membership: marked(7), unread: false })
    const older = new ConversationController({ conversationId: 'room', client: legacy.sdk, autoLoad: false })
    await older.loadInitial()
    await older.markRead()
    expect(legacy.sdk.clearConversationUnread).toBeUndefined()
    expect(legacy.acks()).toEqual([])
    expect(older.getSnapshot().error).toBeNull()
    await controller.dispose(); await older.dispose()
  })
})

describe('message edits', () => {
  const failure = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), { status, ...(code ? { code } : {}) })
  const open = async (rows: Message[], options: Parameters<typeof client>[2] = {}, participants: Participant[] = []) => {
    const fixture = client(rows, participants, options)
    const controller = new ConversationController({ conversationId: 'room', client: fixture.sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    return { ...fixture, controller }
  }
  const edits = (sdk: ConvoKitUiClient) => vi.mocked(sdk.editMessage!).mock.calls.map(([id, input]) => [id, input])
  const row = (controller: ConversationController, id: string) => controller.getSnapshot().messages.find(candidate => candidate.id === id)
  const ids = (controller: ConversationController) => controller.getSnapshot().messages.map(candidate => candidate.id)
  const code = (controller: ConversationController) => (controller.getSnapshot().error as { code?: string } | null)?.code

  it('reports adapter support and enters edit mode only for own confirmed rows', async () => {
    const mine = message('m1', 'me', at(10)), theirs = message('m2', 'alex', at(20))
    const { sdk, controller } = await open([mine, theirs])
    expect(controller.getSnapshot()).toMatchObject({ canEditMessages: true, canDeleteMessages: true, editingMessage: null })
    controller.startEditing('m2')
    expect(controller.getSnapshot().editingMessage).toBeNull()
    controller.startEditing('missing')
    expect(controller.getSnapshot().editingMessage).toBeNull()
    const send = deferred<Message>()
    vi.mocked(sdk.sendMessage).mockReturnValueOnce(send.promise)
    const sending = controller.sendMessage({ text: 'Hello' })
    const pending = controller.getSnapshot().messages.find(candidate => candidate.id.startsWith('convokit-pending-'))!
    controller.startEditing(pending.id)
    expect(controller.getSnapshot().editingMessage).toBeNull()
    expect(await controller.deleteMessage(pending.id)).toBe(false)
    expect(await controller.deleteMessage('m2')).toBe(false)
    expect(sdk.deleteMessage).not.toHaveBeenCalled()
    send.resolve(message('m3', 'me', at(30)))
    await sending
    const typingCalls = vi.mocked(sdk.sendTyping).mock.calls.length
    controller.startEditing('m1')
    expect(controller.getSnapshot().editingMessage).toEqual(mine)
    expect(vi.mocked(sdk.sendTyping).mock.calls).toHaveLength(typingCalls)
    controller.cancelEditing()
    expect(controller.getSnapshot().editingMessage).toBeNull()
    expect(sdk.editMessage).not.toHaveBeenCalled()
    await controller.dispose()
  })

  it('never enters edit mode for a READ role or without the adapter members', async () => {
    const reader = await open([message('m1', 'me', at(10))], { membership: { ...membership(1), role: 'READ' } })
    reader.controller.startEditing('m1')
    expect(reader.controller.getSnapshot().editingMessage).toBeNull()
    const listed = await open([message('m1', 'me', at(10))], {}, [{ ...participant('me'), role: 'READ' }])
    listed.controller.startEditing('m1')
    expect(listed.controller.getSnapshot().editingMessage).toBeNull()
    const legacy = await open([message('m1', 'me', at(10))], { edits: false })
    expect(legacy.controller.getSnapshot()).toMatchObject({ canEditMessages: false, canDeleteMessages: false })
    legacy.controller.startEditing('m1')
    expect(legacy.controller.getSnapshot().editingMessage).toBeNull()
    await expect(legacy.controller.saveEdit('x')).rejects.toThrow('This ConvoKitUiClient adapter does not implement editMessage (0.8)')
    await expect(legacy.controller.deleteMessage('m1')).rejects.toThrow('This ConvoKitUiClient adapter does not implement deleteMessage (0.8)')
    expect(legacy.controller.getSnapshot().messages).toHaveLength(1)
    await reader.controller.dispose(); await listed.controller.dispose(); await legacy.controller.dispose()
  })

  it('sends the snapshot revision even after a same-revision update advanced the live row', async () => {
    const original = message('m1', 'me', at(10))
    const { sdk, controller, live } = await open([original])
    controller.startEditing('m1')
    await live.insert({ ...original, text: 'echo', updatedAt: at(11) }, 'update')
    expect(row(controller, 'm1')?.text).toBe('echo')
    expect(controller.getSnapshot().editingMessage).toEqual(original)
    await expect(controller.saveEdit('  mine  ')).resolves.toBe(true)
    expect(edits(sdk)).toEqual([['m1', { text: 'mine', revision: 0 }]])
    expect(row(controller, 'm1')).toMatchObject({ text: 'mine', revision: 1 })
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, error: null })
    expect(sdk.sendTyping).not.toHaveBeenCalled()
    // The row's own UPDATE image arrives late with the same revision: nothing changes.
    await live.insert({ ...row(controller, 'm1')!, media: [] }, 'update')
    expect(row(controller, 'm1')).toMatchObject({ text: 'mine', revision: 1 })
    expect(edits(sdk)).toHaveLength(1)
    await controller.dispose()
  })

  it('clears a caption with null and keeps the media byte-identical', async () => {
    const photo = message('m1', 'me', at(10), null)
    const media = photo.media
    const { sdk, controller, live } = await open([photo])
    controller.startEditing('m1')
    await expect(controller.saveEdit('   ')).resolves.toBe(true)
    expect(edits(sdk)).toEqual([['m1', { text: null, revision: 0 }]])
    expect(row(controller, 'm1')).toMatchObject({ text: null, revision: 1 })
    expect(row(controller, 'm1')?.media).toEqual(media)
    expect(controller.getSnapshot().editingMessage).toBeNull()
    // The row image of the same edit (no media on the wire) is hydrated before it is applied: no flicker.
    const saved = row(controller, 'm1')!
    vi.mocked(sdk.getMessage).mockResolvedValueOnce(saved)
    await live.insert({ ...saved, media: [] }, 'update')
    expect(row(controller, 'm1')).toEqual(saved)
    expect(row(controller, 'm1')?.media).toEqual(media)
    await controller.dispose()
  })

  it('never saves a text-only message empty', async () => {
    const { sdk, controller } = await open([message('m1', 'me', at(10))])
    controller.startEditing('m1')
    await expect(controller.saveEdit('   ')).resolves.toBe(false)
    expect(sdk.editMessage).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: { id: 'm1' }, error: null })
    await controller.dispose()
  })

  it('reloads once on a 409, refreshes the snapshot and saves with the fresh revision next', async () => {
    const original = message('m1', 'me', at(10))
    const { sdk, controller, rows } = await open([original])
    controller.startEditing('m1')
    const theirs = { ...original, text: 'theirs', revision: 1, updatedAt: at(20) }
    rows[0] = theirs
    const fetches = vi.mocked(sdk.getMessage).mock.calls.length
    await expect(controller.saveEdit('mine')).resolves.toBe(false)
    expect(edits(sdk)).toEqual([['m1', { text: 'mine', revision: 0 }]])
    expect(vi.mocked(sdk.getMessage).mock.calls.length - fetches).toBe(1)
    expect(row(controller, 'm1')).toEqual(theirs)
    expect(controller.getSnapshot().editingMessage).toEqual(theirs)
    expect(code(controller)).toBe('REVISION_CONFLICT')
    await expect(controller.saveEdit('mine')).resolves.toBe(true)
    expect(edits(sdk)[1]).toEqual(['m1', { text: 'mine', revision: 1 }])
    expect(row(controller, 'm1')).toMatchObject({ text: 'mine', revision: 2 })
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, error: null })
    await controller.dispose()
  })

  it('enters the conflict state locally when a newer row image arrives while editing', async () => {
    const original = message('m1', 'me', at(10))
    const { sdk, controller, live, rows } = await open([original])
    controller.startEditing('m1')
    const theirs = { ...original, text: 'theirs', revision: 1, updatedAt: at(20) }
    await live.insert(theirs, 'update')
    expect(sdk.editMessage).not.toHaveBeenCalled()
    expect(row(controller, 'm1')).toEqual(theirs)
    expect(controller.getSnapshot().editingMessage).toEqual(theirs)
    expect(code(controller)).toBe('REVISION_CONFLICT')
    // A refresh that brings a newer revision is a conflict too; a stale re-delivery never rewinds the row.
    const newest = { ...theirs, text: 'newer', revision: 2 }
    vi.mocked(sdk.getMessages).mockResolvedValueOnce([newest])
    await controller.refresh()
    expect(controller.getSnapshot().editingMessage).toEqual(newest)
    await live.insert(original, 'update')
    expect(row(controller, 'm1')).toEqual(newest)
    rows[0] = newest
    await expect(controller.saveEdit('mine')).resolves.toBe(true)
    expect(edits(sdk)).toEqual([['m1', { text: 'mine', revision: 2 }]])
    await controller.dispose()
  })

  it('removes the row and leaves edit mode when the conflict reload reports it deleted', async () => {
    const { sdk, controller } = await open([message('m1', 'me', at(10)), message('m2', 'alex', at(20))])
    controller.startEditing('m1')
    vi.mocked(sdk.editMessage!).mockRejectedValueOnce(conflict())
    vi.mocked(sdk.getMessage).mockRejectedValueOnce(missing())
    await expect(controller.saveEdit('mine')).resolves.toBe(false)
    expect(ids(controller)).toEqual(['m2'])
    expect(controller.getSnapshot().editingMessage).toBeNull()
    expect(code(controller)).toBe('MESSAGE_NOT_FOUND')
    // A reload that fails otherwise keeps the snapshot and surfaces that failure.
    const other = await open([message('m1', 'me', at(10))])
    other.controller.startEditing('m1')
    vi.mocked(other.sdk.editMessage!).mockRejectedValueOnce(conflict())
    vi.mocked(other.sdk.getMessage).mockRejectedValueOnce(failure(500))
    await expect(other.controller.saveEdit('mine')).resolves.toBe(false)
    expect(other.controller.getSnapshot().editingMessage).toMatchObject({ id: 'm1', revision: 0 })
    expect(other.controller.getSnapshot().error).toEqual(failure(500))
    expect(ids(other.controller)).toEqual(['m1'])
    await controller.dispose(); await other.controller.dispose()
  })

  it('keeps the session, the row and history on network, 500 and 403 failures', async () => {
    const original = message('m1', 'me', at(10))
    const { sdk, controller } = await open([original, message('m2', 'alex', at(20))])
    controller.startEditing('m1')
    for (const error of [new Error('offline'), failure(500), failure(403)]) {
      vi.mocked(sdk.editMessage!).mockRejectedValueOnce(error)
      await expect(controller.saveEdit('mine')).resolves.toBe(false)
      expect(controller.getSnapshot().error).toBe(error)
      expect(controller.getSnapshot().editingMessage).toEqual(original)
      expect(ids(controller)).toEqual(['m1', 'm2'])
    }
    expect(edits(sdk)).toHaveLength(3)
    await controller.dispose()
  })

  it('leaves edit mode when the edited row is deleted remotely', async () => {
    const { controller, live } = await open([message('m1', 'me', at(10))])
    controller.startEditing('m1')
    await live.remove('m1')
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, messages: [] })
    await controller.dispose()
  })

  it('treats a coded 404 as a deletion and an uncoded 404 as a plain failure', async () => {
    const coded = await open([message('m1', 'me', at(10)), message('m2', 'alex', at(20))])
    coded.controller.startEditing('m1')
    vi.mocked(coded.sdk.editMessage!).mockRejectedValueOnce(missing())
    await expect(coded.controller.saveEdit('mine')).resolves.toBe(false)
    expect(ids(coded.controller)).toEqual(['m2'])
    expect(coded.controller.getSnapshot().editingMessage).toBeNull()
    expect(code(coded.controller)).toBe('MESSAGE_NOT_FOUND')
    // A 0.7 backend answers the unmatched `/own` route with an HTML 404 without a code.
    const legacy = await open([message('m1', 'me', at(10))])
    legacy.controller.startEditing('m1')
    const html = Object.assign(new Error('HTTP 404'), { status: 404, code: 'HTTP_ERROR' })
    vi.mocked(legacy.sdk.editMessage!).mockRejectedValueOnce(html)
    await expect(legacy.controller.saveEdit('mine')).resolves.toBe(false)
    expect(ids(legacy.controller)).toEqual(['m1'])
    expect(legacy.controller.getSnapshot()).toMatchObject({ editingMessage: { id: 'm1' }, error: html })
    await coded.controller.dispose(); await legacy.controller.dispose()
  })

  it('deletes through the adapter, tombstones the row and drops every late answer for it', async () => {
    const mine = message('m2', 'me', at(20))
    const { sdk, controller, live, targets } = await open([message('m1', 'alex', at(10)), mine])
    await controller.markRead()
    expect(targets()).toEqual(['m2'])
    controller.startEditing('m2')
    const edit = deferred<Message>()
    vi.mocked(sdk.editMessage!).mockReturnValueOnce(edit.promise)
    const saving = controller.saveEdit('mine')
    await expect(controller.deleteMessage('m2')).resolves.toBe(true)
    expect(sdk.deleteMessage).toHaveBeenCalledWith('m2')
    expect(ids(controller)).toEqual(['m1'])
    expect(controller.getSnapshot().editingMessage).toBeNull()
    // The removed acknowledgement target falls back to the next newest row once.
    expect(targets()).toEqual(['m2', 'm1'])
    edit.resolve({ ...mine, text: 'mine', revision: 1 })
    await saving
    expect(ids(controller)).toEqual(['m1'])
    await live.insert({ ...mine, text: 'mine', revision: 1 }, 'update')
    await live.insert(mine, 'insert')
    expect(ids(controller)).toEqual(['m1'])
    const before = targets().length
    await live.remove('m2')
    expect(ids(controller)).toEqual(['m1'])
    expect(targets()).toHaveLength(before)
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })

  it('removes the row on a delete that answers MESSAGE_NOT_FOUND and keeps it on other failures', async () => {
    const { sdk, controller } = await open([message('m1', 'me', at(10))])
    for (const error of [failure(404), failure(500)]) {
      vi.mocked(sdk.deleteMessage!).mockRejectedValueOnce(error)
      await expect(controller.deleteMessage('m1')).resolves.toBe(false)
      expect(ids(controller)).toEqual(['m1'])
      expect(controller.getSnapshot().error).toBe(error)
    }
    controller.startEditing('m1')
    vi.mocked(sdk.deleteMessage!).mockRejectedValueOnce(missing())
    await expect(controller.deleteMessage('m1')).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ messages: [], editingMessage: null, error: null })
    await controller.dispose()
  })

  it('never reads the in-flight save\'s own row image as a conflict, and re-checks after a failed save', async () => {
    const original = message('m1', 'me', at(10))
    const { sdk, controller, live } = await open([original])
    controller.startEditing('m1')
    const edit = deferred<Message>()
    vi.mocked(sdk.editMessage!).mockReturnValueOnce(edit.promise)
    const saving = controller.saveEdit('mine')
    // The edit's UPDATE image (revision 1) beats the PATCH response: the row updates, no conflict is raised.
    const saved = { ...original, text: 'mine', revision: 1, updatedAt: at(50) }
    await live.insert(saved, 'update')
    expect(row(controller, 'm1')).toEqual(saved)
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: original, error: null })
    edit.resolve(saved)
    await expect(saving).resolves.toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, error: null })
    // A newer row image that arrives during a save that then fails is a conflict after all.
    controller.startEditing('m1')
    const failing = deferred<Message>()
    vi.mocked(sdk.editMessage!).mockReturnValueOnce(failing.promise)
    const retry = controller.saveEdit('again')
    const theirs = { ...saved, text: 'theirs', revision: 2, updatedAt: at(60) }
    await live.insert(theirs, 'update')
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: saved, error: null })
    failing.reject(new Error('offline'))
    await expect(retry).resolves.toBe(false)
    expect(controller.getSnapshot().editingMessage).toEqual(theirs)
    expect(code(controller)).toBe('REVISION_CONFLICT')
    expect(row(controller, 'm1')).toEqual(theirs)
    await controller.dispose()
  })

  it('never lets a stale refresh page rewind a newer edited row', async () => {
    const original = message('m1', 'me', at(10))
    const { sdk, controller } = await open([original])
    const page = deferred<Message[]>()
    vi.mocked(sdk.getMessages).mockReturnValueOnce(page.promise)
    const refreshing = controller.refresh()
    controller.startEditing('m1')
    await expect(controller.saveEdit('mine')).resolves.toBe(true)
    expect(row(controller, 'm1')).toMatchObject({ text: 'mine', revision: 1 })
    // The page was fetched before the edit: revision 0 never overwrites revision 1.
    page.resolve([original])
    await refreshing
    expect(row(controller, 'm1')).toMatchObject({ text: 'mine', revision: 1 })
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, error: null, isReconciling: false })
    await controller.dispose()
  })

  it('leaves edit mode when a refresh no longer carries the edited row', async () => {
    const { sdk, controller, rows } = await open([message('m1', 'me', at(10)), message('m2', 'alex', at(20))])
    controller.startEditing('m1')
    rows.splice(0, 1)
    await controller.refresh()
    expect(ids(controller)).toEqual(['m2'])
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, error: null })
    // A refresh that still carries the row keeps the session.
    rows.push(message('m3', 'me', at(30)))
    await controller.refresh()
    controller.startEditing('m2')
    expect(controller.getSnapshot().editingMessage).toBeNull()
    controller.startEditing('m3')
    await controller.refresh()
    expect(controller.getSnapshot().editingMessage).toMatchObject({ id: 'm3', revision: 0 })
    expect(code(controller)).toBeUndefined()
    expect(sdk.editMessage).not.toHaveBeenCalled()
    await controller.dispose()
  })

  // A row the reconciled range no longer carries was deleted while the client was away: it is tombstoned
  // like a `message_deleted`, so nothing that answers late for it can bring it back.
  it('tombstones a known row a refresh no longer carries so late answers cannot re-add it', async () => {
    const mine = message('m2', 'me', at(20))
    const { sdk, controller, live, rows, targets } = await open([message('m1', 'alex', at(10)), mine])
    await controller.markRead()
    expect(targets()).toEqual(['m2'])
    controller.startEditing('m2')
    const edit = deferred<Message>()
    vi.mocked(sdk.editMessage!).mockReturnValueOnce(edit.promise)
    const saving = controller.saveEdit('mine')
    rows.splice(1, 1)
    await controller.refresh()
    expect(ids(controller)).toEqual(['m1'])
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, error: null, isReconciling: false })
    // The removed acknowledgement target falls back to the next newest row, as for any deletion.
    expect(targets()).toEqual(['m2', 'm1'])
    // The late edit response, a row image, a hydration and a late deletion for the id are all dropped.
    edit.resolve({ ...mine, text: 'mine', revision: 1 })
    await saving
    expect(ids(controller)).toEqual(['m1'])
    await live.insert({ ...mine, text: 'mine', revision: 1 }, 'update')
    await live.insert(mine, 'insert')
    expect(ids(controller)).toEqual(['m1'])
    expect(vi.mocked(sdk.getMessage).mock.calls.map(([id]) => id)).not.toContain('m2')
    await live.remove('m2')
    expect(ids(controller)).toEqual(['m1'])
    expect(targets()).toEqual(['m2', 'm1'])
    expect(controller.getSnapshot().error).toBeNull()
    // The next loadInitial starts over: the id is a live row again.
    await controller.loadInitial()
    expect(ids(controller)).toEqual(['m1', 'm2'])
    await controller.dispose()
  })

  it('never tombstones a row older than the reconciled range', async () => {
    const [m1, m2] = [message('m1', 'alex', at(10)), message('m2', 'alex', at(20))]
    const fixture = client([m1, m2])
    // A page honours `limit` (newest first), like the server.
    vi.mocked(fixture.sdk.getMessages).mockImplementation(async ({ limit }) => [...fixture.rows].reverse().slice(0, limit))
    const controller = new ConversationController({ conversationId: 'room', client: fixture.sdk, autoLoad: false, markReadOnLoad: false, messagePageSize: 2 })
    await controller.loadInitial()
    expect(ids(controller)).toEqual(['m1', 'm2'])
    // Two rows arrived while away: the refetched page ends at m3, so m1 and m2 are outside the window.
    fixture.rows.push(message('m3', 'alex', at(30)), message('m4', 'alex', at(40)))
    await controller.refresh()
    expect(ids(controller)).toEqual(['m3', 'm4'])
    expect(controller.getSnapshot().error).toBeNull()
    await fixture.live.insert({ ...m1, text: 'still here', revision: 1 }, 'update')
    expect(ids(controller)).toEqual(['m1', 'm3', 'm4'])
    expect(row(controller, 'm1')?.text).toBe('still here')
    // A row inside the window that the page no longer carries is gone for good (the window now spans the
    // three rendered rows, so m2 is back in it and m3, deleted meanwhile, is tombstoned).
    fixture.rows.splice(fixture.rows.findIndex(candidate => candidate.id === 'm3'), 1)
    await controller.refresh()
    expect(ids(controller)).toEqual(['m1', 'm2', 'm4'])
    await fixture.live.insert(message('m3', 'alex', at(30)), 'update')
    expect(ids(controller)).toEqual(['m1', 'm2', 'm4'])
    await controller.dispose()
  })

  /** `getMessages` as the backend serves it: newest first, honouring the cursor, `limit` clamped to 100. */
  const server = (rows: Message[]) => async ({ limit, beforeCreatedAt, beforeId }: Parameters<ConvoKitUiClient['getMessages']>[0]) => {
    const before = beforeCreatedAt && beforeId ? { id: beforeId, createdAt: beforeCreatedAt } : null
    return [...rows].reverse()
      .filter(candidate => !before || candidate.createdAt < before.createdAt || (candidate.createdAt.getTime() === before.createdAt.getTime() && candidate.id < before.id))
      .slice(0, Math.min(Math.max(limit, 1), 100))
  }
  const history = (count: number) => Array.from({ length: count }, (_, index) => message(`m${String(index + 1).padStart(3, '0')}`, 'alex', at(index + 1)))

  it('reconciles at most the server page cap: rows beyond it are neither tombstoned nor lost', async () => {
    const fixture = client(history(130))
    vi.mocked(fixture.sdk.getMessages).mockImplementation(server(fixture.rows))
    const controller = new ConversationController({ conversationId: 'room', client: fixture.sdk, autoLoad: false, markReadOnLoad: false, messagePageSize: 30 })
    await controller.loadInitial()
    for (let page = 0; page < 3; page++) await controller.loadOlderMessages()
    expect(ids(controller)).toHaveLength(120)
    // m100 was deleted meanwhile (inside the window); the capped page then spans m030..m130, so m011..m029
    // only fall outside the 100-row window.
    fixture.rows.splice(fixture.rows.findIndex(candidate => candidate.id === 'm100'), 1)
    await controller.refresh()
    expect(vi.mocked(fixture.sdk.getMessages).mock.calls.at(-1)![0]).toMatchObject({ limit: 100, offset: 0 })
    expect(controller.getSnapshot()).toMatchObject({ error: null, hasOlderMessages: true })
    expect(ids(controller)).toHaveLength(100)
    expect(ids(controller)[0]).toBe('m030')
    await fixture.live.insert(message('m100', 'alex', at(100)), 'update')
    expect(row(controller, 'm100')).toBeUndefined()
    // The next history page brings the rows outside the window back; the deletion stays.
    await controller.loadOlderMessages()
    expect(ids(controller)).toHaveLength(129)
    expect(ids(controller).slice(0, 3)).toEqual(['m001', 'm002', 'm003'])
    expect(ids(controller)).toContain('m029')
    expect(ids(controller)).not.toContain('m100')
    await controller.dispose()
  })

  it('reopens an exhausted history when the reconciled window drops rows from view', async () => {
    const fixture = client(history(110))
    vi.mocked(fixture.sdk.getMessages).mockImplementation(server(fixture.rows))
    const controller = new ConversationController({ conversationId: 'room', client: fixture.sdk, autoLoad: false, markReadOnLoad: false, messagePageSize: 30 })
    await controller.loadInitial()
    for (let page = 0; page < 3; page++) await controller.loadOlderMessages()
    expect(ids(controller)).toHaveLength(110)
    expect(controller.getSnapshot().hasOlderMessages).toBe(false)
    await controller.refresh()
    expect(ids(controller)).toHaveLength(100)
    expect(controller.getSnapshot().hasOlderMessages).toBe(true)
    await controller.loadOlderMessages()
    expect(ids(controller)).toHaveLength(110)
    expect(ids(controller)[0]).toBe('m001')
    expect(controller.getSnapshot().hasOlderMessages).toBe(false)
    await controller.dispose()
  })

  it('never lets a revision 2 response overwrite a live revision 3 row', async () => {
    const original = { ...message('m1', 'me', at(10)), revision: 1 }
    const { sdk, controller, live } = await open([original])
    controller.startEditing('m1')
    const edit = deferred<Message>()
    vi.mocked(sdk.editMessage!).mockReturnValueOnce(edit.promise)
    const saving = controller.saveEdit('mine')
    const newest = { ...original, text: 'theirs', revision: 3, updatedAt: at(30) }
    await live.insert(newest, 'update')
    // The row shows the newer content at once; the in-flight save's snapshot waits for the response.
    expect(row(controller, 'm1')).toEqual(newest)
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: original, error: null })
    edit.resolve({ ...original, text: 'mine', revision: 2, updatedAt: at(40) })
    await expect(saving).resolves.toBe(true)
    expect(row(controller, 'm1')).toEqual(newest)
    expect(controller.getSnapshot()).toMatchObject({ editingMessage: null, error: null })
    await controller.dispose()
  })
})

const room = (id: string, overrides: Partial<Conversation> = {}): Conversation => ({
  ...conversation, id, title: id, displayTitle: id, ...overrides,
})
/** 0.7 summary literal: `isUnread` is derived from the count, the cap and the marker unless overridden. */
const summary = (activityAt: Date, overrides: Partial<InboxSummary> = {}): InboxSummary => {
  const base = { latestMessage: null, unreadCount: 0, unreadCountCapped: false, readPosition: null, lastReadAt: null, unreadMarkedAt: null, privateStateVersion: 0, activityAt, ...overrides }
  return { isUnread: base.unreadCount > 0 || base.unreadCountCapped || base.unreadMarkedAt !== null, ...base }
}
const entry = (id: string, seconds: number, overrides: Partial<InboxSummary> = {}): InboxEntry => ({
  conversation: room(id), ...summary(at(seconds), overrides),
})
const page = (entries: InboxEntry[], nextCursor: string | null = null): InboxPage => ({ entries, nextCursor })
type InboxRequest = { limit: number; cursor: string | null; archived: boolean }
const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code })

/** `inbox: false` is a 0.5 adapter (legacy path); `unread: false` a 0.6 adapter without the mark/clear members. */
function listClient(options: { inbox?: boolean; unread?: boolean } = {}) {
  const session = {}
  const signals: { activity?: () => void; changed?: () => void; ended?: () => void } = {}
  const sdk: ConvoKitUiClient = {
    currentUserId: 'me', sessionIdentity: session,
    getConversations: vi.fn().mockResolvedValue([]),
    ...(options.inbox === false ? {} : { listInbox: vi.fn().mockResolvedValue(page([])) }),
    ...(options.unread === false ? {} : {
      markConversationUnread: vi.fn(async (id: string): Promise<ConversationPrivateState> =>
        ({ conversationId: id, unreadMarkedAt: at(60), privateStateVersion: 1 })),
      clearConversationUnread: vi.fn(async (id: string): Promise<ClearUnreadResult> =>
        ({ conversationId: id, cleared: true, unreadMarkedAt: null, privateStateVersion: 2 })),
    }),
    getConversation: vi.fn(), getMessages: vi.fn(), getMessage: vi.fn(), sendMessage: vi.fn(),
    markConversationRead: vi.fn().mockResolvedValue(undefined), sendTyping: vi.fn().mockResolvedValue(undefined),
    onConnectionEvent: vi.fn((_, ended) => { signals.ended = ended; return close() }),
    onInboxChanged: vi.fn(handler => { signals.changed = handler; return close() }),
    onInboxActivity: vi.fn(handler => { signals.activity = handler; return close() }),
    onMessage: vi.fn(close), onMessageDeleted: vi.fn(close), onReadReceipt: vi.fn(close), onTyping: vi.fn(close),
  }
  const inbox = (script: (input: InboxRequest) => InboxPage | Promise<InboxPage>) =>
    vi.mocked(sdk.listInbox!).mockImplementation(input => Promise.resolve(script(input)))
  const requests = (): InboxRequest[] => vi.mocked(sdk.listInbox!).mock.calls.map(([input]) => input)
  /** Head walks after the initial load: each refresh starts at the null cursor. */
  const walks = () => requests().filter(input => input.cursor === null).length - 1
  return { sdk, signals, inbox, requests, walks }
}

describe('ConversationListController', () => {
  const list = (sdk: ConvoKitUiClient, options: Partial<ConstructorParameters<typeof ConversationListController>[0]> = {}) =>
    new ConversationListController({ client: sdk, autoLoad: false, pageSize: 2, ...options })
  const ids = (controller: ConversationListController) => controller.getSnapshot().conversations.map(row => row.id)

  it('loads inbox pages by cursor with summaries and the bound user', async () => {
    const { sdk, inbox, requests } = listClient()
    inbox(({ cursor }) => cursor === null
      ? page([entry('a', 50, { unreadCount: 2 }), entry('b', 40)], 'c1')
      : page([entry('c', 30)]))
    const controller = list(sdk)
    await controller.loadInitial()
    expect(requests()).toEqual([{ limit: 2, cursor: null, archived: false }])
    expect(ids(controller)).toEqual(['a', 'b'])
    expect(controller.getSnapshot().summaries.get('a')?.unreadCount).toBe(2)
    expect(controller.getSnapshot()).toMatchObject({ hasMore: true, hasLoaded: true, currentUserId: 'me', error: null, isRefreshing: false })
    await controller.loadMore()
    expect(requests()[1]).toEqual({ limit: 2, cursor: 'c1', archived: false })
    expect(ids(controller)).toEqual(['a', 'b', 'c'])
    expect(controller.getSnapshot().hasMore).toBe(false)
    expect(sdk.getConversations).not.toHaveBeenCalled()
    expect(sdk.onInboxActivity).toHaveBeenCalledTimes(1)
    await controller.dispose()
    expect(controller.getSnapshot().currentUserId).toBe('')
  })

  it('lets a later entry win for a room that moved and re-sorts by activity then id', async () => {
    const { sdk, inbox } = listClient()
    inbox(({ cursor }) => cursor === null
      ? page([entry('a', 50), entry('b', 40)], 'c1')
      : page([entry('c', 30), entry('b', 20, { unreadCount: 1 })]))
    const controller = list(sdk)
    await controller.loadInitial()
    await controller.loadMore()
    expect(ids(controller)).toEqual(['a', 'c', 'b'])
    expect(controller.getSnapshot().summaries.get('b')).toMatchObject({ activityAt: at(20), unreadCount: 1 })
    expect(controller.getSnapshot().error).toBeNull()
    const tie = mergeInboxEntries([], new Map(), [entry('x', 10), entry('z', 10), entry('y', 10)])
    expect(tie.conversations.map(row => row.id)).toEqual(['z', 'y', 'x'])
    await controller.dispose()
  })

  it('merges a full page of already-loaded ids in place when the cursor advanced', async () => {
    const { sdk, inbox, requests } = listClient()
    inbox(({ cursor }) => cursor === null ? page([entry('a', 50), entry('b', 40)], 'c1')
      : cursor === 'c1' ? page([entry('a', 50), entry('b', 40)], 'c2') : page([]))
    const controller = list(sdk)
    await controller.loadInitial()
    await controller.loadMore()
    expect(requests().map(input => input.cursor)).toEqual([null, 'c1', 'c2'])
    expect(ids(controller)).toEqual(['a', 'b'])
    expect(controller.getSnapshot()).toMatchObject({ hasMore: false, error: null })
    await controller.dispose()
  })

  it('rejects a page whose cursor did not advance and keeps the loaded rows', async () => {
    const { sdk, inbox } = listClient()
    inbox(({ cursor }) => cursor === null ? page([entry('a', 50)], 'c1') : page([entry('b', 40)], 'c1'))
    const controller = list(sdk)
    await controller.loadInitial()
    await controller.loadMore()
    expect(controller.getSnapshot().error).toEqual(new Error('Inbox pagination did not advance'))
    expect(ids(controller)).toEqual(['a'])
    const { sdk: emptySdk, inbox: emptyInbox } = listClient()
    emptyInbox(() => page([], 'c1'))
    const empty = list(emptySdk)
    await empty.loadInitial()
    expect(empty.getSnapshot().error).toEqual(new Error('Inbox pagination did not advance'))
    await controller.dispose(); await empty.dispose()
  })

  it('refreshes the loaded window from the head in pages of at most 100', async () => {
    const { sdk, inbox, requests } = listClient()
    const rows = Array.from({ length: 130 }, (_, index) => entry(`r${String(index).padStart(3, '0')}`, 5000 - index))
    inbox(({ cursor, limit }) => {
      const start = cursor === null ? 0 : Number(cursor.slice(2))
      const end = Math.min(rows.length, start + limit)
      return page(rows.slice(start, end), end < rows.length ? `k:${end}` : null)
    })
    const controller = list(sdk, { pageSize: 50 })
    await controller.loadInitial(); await controller.loadMore(); await controller.loadMore()
    expect(ids(controller)).toHaveLength(130)
    expect(controller.getSnapshot().hasMore).toBe(false)
    const before = requests().length
    await controller.refresh()
    expect(requests().slice(before)).toEqual([
      { limit: 100, cursor: null, archived: false }, { limit: 30, cursor: 'k:100', archived: false },
    ])
    expect(ids(controller)).toHaveLength(130)
    expect(ids(controller)[0]).toBe('r000')
    expect(controller.getSnapshot()).toMatchObject({ hasMore: false, error: null, isRefreshing: false })
    await controller.dispose()
  })

  it('continues a refresh past a fully hidden head page and keeps the walk cursor', async () => {
    const { sdk, inbox, requests } = listClient()
    let refreshed = false
    inbox(({ cursor }) => {
      if (!refreshed) return page([entry('a', 50), entry('b', 40)], 'c1')
      return cursor === null ? page([entry('h1', 90), entry('h2', 80)], 'r1')
        : cursor === 'r1' ? page([entry('a', 50), entry('b', 40)], 'r2') : page([entry('c', 30)])
    })
    const controller = list(sdk, { initialFilter: { predicate: row => !row.id.startsWith('h') } })
    await controller.loadInitial()
    expect(ids(controller)).toEqual(['a', 'b'])
    refreshed = true
    await controller.refresh()
    expect(requests().slice(1)).toEqual([{ limit: 2, cursor: null, archived: false }, { limit: 2, cursor: 'r1', archived: false }])
    expect(ids(controller)).toEqual(['a', 'b'])
    expect(controller.getSnapshot().hasMore).toBe(true)
    await controller.loadMore()
    expect(requests().at(-1)).toEqual({ limit: 2, cursor: 'r2', archived: false })
    expect(ids(controller)).toEqual(['a', 'b', 'c'])
    await controller.dispose()
  })

  it('publishes an empty list with hasMore false once every hidden page is exhausted', async () => {
    const { sdk, inbox } = listClient()
    let refreshed = false
    inbox(({ cursor }) => {
      if (!refreshed) return page([entry('a', 50), entry('b', 40)], 'c1')
      return cursor === null ? page([entry('h1', 90), entry('h2', 80)], 'r1') : page([entry('h3', 70)])
    })
    const controller = list(sdk, { initialFilter: { predicate: row => !row.id.startsWith('h') } })
    await controller.loadInitial()
    refreshed = true
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ conversations: [], hasMore: false, error: null })
    expect(controller.getSnapshot().summaries.size).toBe(3)
    await controller.dispose()
  })

  it('runs a refresh requested during a load afterwards and reports isRefreshing', async () => {
    const { sdk, inbox, requests } = listClient()
    const initial = deferred<InboxPage>()
    let calls = 0
    inbox(() => (++calls === 1 ? initial.promise : page([entry('a', 50)])))
    const controller = list(sdk)
    const load = controller.loadInitial()
    await flush()
    await controller.refresh()
    expect(requests()).toHaveLength(1)
    initial.resolve(page([entry('a', 50)]))
    await load; await flush()
    expect(requests()).toHaveLength(2)
    const walk = deferred<InboxPage>()
    inbox(() => walk.promise)
    const refreshing = controller.refresh()
    expect(controller.getSnapshot().isRefreshing).toBe(true)
    await controller.refresh()
    expect(requests()).toHaveLength(3)
    walk.resolve(page([entry('a', 50)]))
    await refreshing; await flush()
    expect(controller.getSnapshot().isRefreshing).toBe(false)
    expect(requests()).toHaveLength(4)
    await controller.dispose()
  })

  it('runs one head walk after a loadMore for a signal and a refresh requested during it', async () => {
    const { sdk, signals, inbox, requests } = listClient()
    const more = deferred<InboxPage>()
    inbox(({ cursor }) => (cursor === null ? page([entry('a', 50)], 'c1') : more.promise))
    const controller = list(sdk)
    await controller.loadInitial()
    const loading = controller.loadMore()
    await flush()
    expect(controller.getSnapshot().isLoadingMore).toBe(true)
    signals.changed!()
    await controller.refresh()
    expect(requests()).toHaveLength(2)
    more.resolve(page([entry('b', 40)]))
    await loading; await flush()
    expect(requests().slice(2)).toEqual([{ limit: 2, cursor: null, archived: false }, { limit: 1, cursor: 'c1', archived: false }])
    expect(ids(controller)).toEqual(['a', 'b'])
    expect(controller.getSnapshot()).toMatchObject({ isLoadingMore: false, isRefreshing: false, hasMore: false, error: null })
    await controller.dispose()
  })

  it('runs a loadMore requested during a refresh after the walk from the new cursor', async () => {
    const { sdk, inbox, requests } = listClient()
    const walk = deferred<InboxPage>()
    let refreshed = false
    inbox(({ cursor }) => {
      if (!refreshed) return page([entry('a', 50), entry('b', 40)], 'c1')
      return cursor === null ? walk.promise : page([entry('c', 30)])
    })
    const controller = list(sdk)
    await controller.loadInitial()
    refreshed = true
    const refreshing = controller.refresh()
    await flush()
    expect(controller.getSnapshot().isRefreshing).toBe(true)
    await controller.loadMore()
    expect(requests()).toHaveLength(2)
    walk.resolve(page([entry('n', 60), entry('a', 50)], 'r1'))
    await refreshing; await flush()
    expect(requests().slice(2)).toEqual([{ limit: 2, cursor: 'r1', archived: false }])
    expect(ids(controller)).toEqual(['n', 'a', 'c'])
    expect(controller.getSnapshot()).toMatchObject({ isLoadingMore: false, isRefreshing: false, hasMore: false, error: null })
    await controller.dispose()
  })

  describe('activity throttle', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('coalesces a burst into one walk at the end of the window', async () => {
      const { sdk, signals, walks } = listClient()
      const controller = list(sdk)
      await controller.loadInitial()
      for (let index = 0; index < 50; index++) { signals.activity!(); await vi.advanceTimersByTimeAsync(2) }
      expect(walks()).toBe(0)
      await vi.advanceTimersByTimeAsync(399)
      expect(walks()).toBe(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(walks()).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(walks()).toBe(1)
      await controller.dispose()
    })

    it('keeps at most one walk per window under continuous activity', async () => {
      const { sdk, signals, walks } = listClient()
      const controller = list(sdk)
      await controller.loadInitial()
      for (let elapsed = 0; elapsed < 3000; elapsed += 50) { signals.activity!(); await vi.advanceTimersByTimeAsync(50) }
      expect(walks()).toBeGreaterThanOrEqual(5)
      expect(walks()).toBeLessThanOrEqual(7)
      await controller.dispose()
    })

    it('runs exactly one more walk for a signal during a walk', async () => {
      const { sdk, signals, inbox, walks } = listClient()
      const gate = deferred<InboxPage>()
      let calls = 0
      inbox(() => (++calls === 2 ? gate.promise : page([])))
      const controller = list(sdk)
      await controller.loadInitial()
      signals.activity!()
      await vi.advanceTimersByTimeAsync(500)
      expect(walks()).toBe(1)
      expect(controller.getSnapshot().isRefreshing).toBe(true)
      signals.activity!(); signals.activity!()
      await vi.advanceTimersByTimeAsync(500)
      expect(walks()).toBe(1)
      gate.resolve(page([]))
      await vi.advanceTimersByTimeAsync(0)
      expect(walks()).toBe(2)
      await vi.advanceTimersByTimeAsync(3000)
      expect(walks()).toBe(2)
      await controller.dispose()
    })

    it('lets inbox_changed refresh immediately and drops the pending activity timer', async () => {
      const { sdk, signals, walks } = listClient()
      const controller = list(sdk)
      await controller.loadInitial()
      signals.activity!()
      await vi.advanceTimersByTimeAsync(100)
      signals.changed!()
      await vi.advanceTimersByTimeAsync(0)
      expect(walks()).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(walks()).toBe(1)
      await controller.dispose()
    })

    it('lets a manual refresh drop the pending activity timer', async () => {
      const { sdk, signals, walks } = listClient()
      const controller = list(sdk)
      await controller.loadInitial()
      signals.activity!()
      await vi.advanceTimersByTimeAsync(100)
      await controller.refresh()
      expect(walks()).toBe(1)
      await vi.advanceTimersByTimeAsync(2000)
      expect(walks()).toBe(1)
      await controller.dispose()
    })

    it('drops the window on dispose', async () => {
      const { sdk, signals, walks } = listClient()
      const controller = list(sdk)
      await controller.loadInitial()
      signals.activity!()
      await vi.advanceTimersByTimeAsync(100)
      await controller.dispose()
      await vi.advanceTimersByTimeAsync(2000)
      expect(walks()).toBe(0)
    })

    it('refreshes immediately with a zero window', async () => {
      const { sdk, signals, walks } = listClient()
      const controller = list(sdk, { activityRefreshWindowMs: 0 })
      await controller.loadInitial()
      signals.activity!()
      await vi.advanceTimersByTimeAsync(0)
      expect(walks()).toBe(1)
      await controller.dispose()
    })
  })

  it('uses the legacy path with a custom page loader and publishes no summaries', async () => {
    const { sdk } = listClient()
    const pageLoader = vi.fn(async () => [room('legacy')])
    const controller = list(sdk, { pageLoader })
    await controller.loadInitial()
    expect(pageLoader).toHaveBeenCalledWith({ limit: 2, offset: 0, filter: {} })
    expect(sdk.listInbox).not.toHaveBeenCalled()
    expect(ids(controller)).toEqual(['legacy'])
    expect(controller.getSnapshot()).toMatchObject({ currentUserId: '' })
    expect(controller.getSnapshot().summaries.size).toBe(0)
    await controller.dispose()
  })

  it('uses getConversations for an adapter without listInbox', async () => {
    const { sdk } = listClient({ inbox: false })
    vi.mocked(sdk.getConversations).mockResolvedValue([room('legacy')])
    const controller = list(sdk)
    await controller.loadInitial()
    expect(sdk.getConversations).toHaveBeenCalledWith({ limit: 2, offset: 0, archived: false })
    expect(ids(controller)).toEqual(['legacy'])
    expect(controller.getSnapshot()).toMatchObject({ currentUserId: '' })
    expect(controller.getSnapshot().summaries.size).toBe(0)
    await controller.dispose()
  })

  it('falls back to getConversations after a 404 from listInbox and stays there', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { sdk, inbox } = listClient()
    inbox(() => Promise.reject(status(404)))
    vi.mocked(sdk.getConversations).mockImplementation(async ({ offset }) => offset === 0 ? [room('x'), room('y')] : [])
    const controller = list(sdk)
    await controller.loadInitial()
    expect(ids(controller)).toEqual(['x', 'y'])
    expect(controller.getSnapshot()).toMatchObject({ error: null, hasMore: true, currentUserId: '' })
    await controller.refresh()
    await controller.loadMore()
    expect(sdk.listInbox).toHaveBeenCalledTimes(1)
    expect(ids(controller)).toEqual(['x', 'y'])
    expect(controller.getSnapshot().error).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    await controller.dispose()
  })

  it('keeps the loaded rows when the inbox endpoint disappears mid-session', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { sdk, inbox } = listClient()
    inbox(() => page([entry('a', 50), entry('b', 40)], 'c1'))
    vi.mocked(sdk.getConversations).mockImplementation(async ({ offset }) => offset === 0 ? [room('a'), room('b')] : [])
    const controller = list(sdk)
    await controller.loadInitial()
    inbox(() => Promise.reject(status(404)))
    await controller.refresh()
    expect(ids(controller)).toEqual(['a', 'b'])
    expect(controller.getSnapshot().error).toBeNull()
    expect(controller.getSnapshot().summaries.size).toBe(0)
    expect(sdk.getConversations).toHaveBeenCalledWith({ limit: 2, offset: 0, archived: false })
    expect(sdk.listInbox).toHaveBeenCalledTimes(2)
    vi.mocked(console.warn).mockRestore()
    await controller.dispose()
  })

  it('continues a loadMore from the loaded count after a 404 and probes the inbox again on the next loadInitial', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { sdk, inbox, requests } = listClient()
    inbox(({ cursor }) => (cursor === null ? page([entry('a', 50), entry('b', 40)], 'c1') : Promise.reject(status(404))))
    vi.mocked(sdk.getConversations).mockImplementation(async ({ offset }) =>
      offset === 0 ? [room('a'), room('b')] : offset === 2 ? [room('c')] : [])
    const controller = list(sdk)
    await controller.loadInitial()
    await controller.loadMore()
    expect(sdk.getConversations).toHaveBeenCalledTimes(1)
    expect(sdk.getConversations).toHaveBeenCalledWith({ limit: 2, offset: 2, archived: false })
    expect(ids(controller)).toEqual(['a', 'b', 'c'])
    expect(controller.getSnapshot()).toMatchObject({ hasMore: false, error: null, currentUserId: '' })
    expect(controller.getSnapshot().summaries.size).toBe(0)
    await controller.loadInitial()
    expect(requests()).toHaveLength(3)
    expect(ids(controller)).toEqual(['a', 'b'])
    expect(controller.getSnapshot()).toMatchObject({ hasMore: true, error: null, currentUserId: 'me' })
    expect(controller.getSnapshot().summaries.size).toBe(2)
    inbox(() => Promise.reject(status(404)))
    await controller.loadInitial()
    expect(requests()).toHaveLength(4)
    expect(sdk.getConversations).toHaveBeenLastCalledWith({ limit: 2, offset: 0, archived: false })
    expect(ids(controller)).toEqual(['a', 'b'])
    expect(controller.getSnapshot()).toMatchObject({ error: null, currentUserId: '' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    await controller.dispose()
  })

  it('evicts rows on a legacy 404 and on an inbox 401, keeps them on a 400', async () => {
    const { sdk: legacySdk } = listClient({ inbox: false })
    vi.mocked(legacySdk.getConversations).mockResolvedValue([room('a')])
    const legacy = list(legacySdk)
    await legacy.loadInitial()
    vi.mocked(legacySdk.getConversations).mockRejectedValue(status(404))
    await legacy.refresh()
    expect(legacy.getSnapshot()).toMatchObject({ conversations: [], hasMore: false })
    expect(legacy.getSnapshot().error).toEqual(status(404))

    const { sdk, inbox } = listClient()
    inbox(() => page([entry('a', 50)]))
    const controller = list(sdk)
    await controller.loadInitial()
    inbox(() => Promise.reject(status(400)))
    await controller.refresh()
    expect(ids(controller)).toEqual(['a'])
    expect(controller.getSnapshot().error).toEqual(status(400))
    inbox(() => Promise.reject(status(401)))
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ conversations: [], hasMore: false })
    expect(controller.getSnapshot().summaries.size).toBe(0)
    expect(controller.getSnapshot().error).toEqual(status(401))
    await legacy.dispose(); await controller.dispose()
  })

  it('retires on session end, ignores later signals and recovers on the next loadInitial', async () => {
    const { sdk, signals, inbox, walks, requests } = listClient()
    inbox(() => page([entry('a', 50)]))
    const controller = list(sdk, { activityRefreshWindowMs: 0 })
    await controller.loadInitial()
    signals.ended!()
    expect(controller.getSnapshot()).toMatchObject({ conversations: [], hasMore: false, currentUserId: '', isInitialLoading: false })
    expect(controller.getSnapshot().error).toEqual(new Error('ConvoKit session ended'))
    signals.activity!(); signals.changed!()
    await controller.refresh(); await flush()
    expect(walks()).toBe(0)
    Object.assign(sdk, { sessionIdentity: {} })
    await controller.loadInitial()
    expect(requests()).toHaveLength(2)
    expect(ids(controller)).toEqual(['a'])
    expect(controller.getSnapshot()).toMatchObject({ currentUserId: 'me', error: null, hasLoaded: true, isInitialLoading: false })
    signals.changed!(); await flush()
    expect(requests()).toHaveLength(3)
    await controller.dispose()
  })

  it('clears the busy flags and the queued refresh when the session ends mid-load', async () => {
    const { sdk, signals, inbox, requests } = listClient()
    const gate = deferred<InboxPage>()
    inbox(({ cursor }) => (cursor === null ? page([entry('a', 50)], 'c1') : gate.promise))
    const controller = list(sdk)
    await controller.loadInitial()
    const loading = controller.loadMore()
    await flush()
    await controller.refresh()
    expect(controller.getSnapshot()).toMatchObject({ isLoadingMore: true, isRefreshing: false })
    signals.ended!()
    expect(controller.getSnapshot()).toMatchObject({ conversations: [], isLoadingMore: false, isRefreshing: false, hasMore: false })
    gate.resolve(page([entry('b', 40)]))
    await loading; await flush()
    expect(requests()).toHaveLength(2)
    expect(controller.getSnapshot()).toMatchObject({ conversations: [], isLoadingMore: false, isRefreshing: false })
    expect(controller.getSnapshot().error).toEqual(new Error('ConvoKit session ended'))
    await controller.dispose()
  })

  it('lets filter.comparator win over activity order', async () => {
    const { sdk, inbox } = listClient()
    inbox(() => page([entry('b', 50), entry('a', 40)]))
    const controller = list(sdk, { initialFilter: { comparator: (left, right) => left.id.localeCompare(right.id) } })
    await controller.loadInitial()
    expect(ids(controller)).toEqual(['a', 'b'])
    await controller.setFilter({})
    expect(ids(controller)).toEqual(['b', 'a'])
    await controller.dispose()
  })

  describe('private unread marker', () => {
    const marker = (seconds: number, privateStateVersion: number): Partial<InboxSummary> => ({ unreadMarkedAt: at(seconds), privateStateVersion })
    const summaryOf = (controller: ConversationListController, id: string) => controller.getSnapshot().summaries.get(id)

    it('parses a marked entry as unread with no count and keeps it through a loadMore merge', async () => {
      const { sdk, inbox } = listClient()
      inbox(({ cursor }) => cursor === null
        ? page([entry('a', 50, marker(60, 1)), entry('b', 40)], 'c1')
        : page([entry('c', 30), entry('b', 20)]))
      const controller = list(sdk)
      await controller.loadInitial()
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: true, unreadCount: 0, unreadMarkedAt: at(60), privateStateVersion: 1 })
      expect(summaryOf(controller, 'b')).toMatchObject({ isUnread: false, unreadMarkedAt: null, privateStateVersion: 0 })
      await controller.loadMore()
      expect(ids(controller)).toEqual(['a', 'c', 'b'])
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: true, unreadMarkedAt: at(60), privateStateVersion: 1 })
      await controller.dispose()
    })

    it('marks a room unread and patches its summary from the response without a refetch', async () => {
      const { sdk, inbox, requests } = listClient()
      inbox(() => page([entry('a', 50), entry('b', 40)]))
      const controller = list(sdk)
      await controller.loadInitial()
      const listener = vi.fn(); controller.subscribe(listener)
      await controller.markUnread('a')
      expect(sdk.markConversationUnread).toHaveBeenCalledWith('a')
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: true, unreadCount: 0, unreadMarkedAt: at(60), privateStateVersion: 1 })
      expect(summaryOf(controller, 'b')).toMatchObject({ isUnread: false, unreadMarkedAt: null, privateStateVersion: 0 })
      expect(listener).toHaveBeenCalledTimes(1)
      expect(requests()).toHaveLength(1)
      expect(controller.getSnapshot().error).toBeNull()
      await controller.dispose()
    })

    it('clears a marker, resolves the response\'s cleared and patches on both answers', async () => {
      const { sdk, inbox } = listClient()
      inbox(() => page([entry('a', 50, marker(60, 1))]))
      const controller = list(sdk)
      await controller.loadInitial()
      await expect(controller.clearUnread('a', { ifVersion: 1 })).resolves.toBe(true)
      expect(sdk.clearConversationUnread).toHaveBeenCalledWith('a', { ifVersion: 1 })
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, unreadMarkedAt: null, privateStateVersion: 2 })
      // A stale conditional clear answers cleared: false with the current (re-marked) state, applied as well.
      vi.mocked(sdk.clearConversationUnread!).mockResolvedValueOnce({ conversationId: 'a', cleared: false, unreadMarkedAt: at(70), privateStateVersion: 3 })
      await expect(controller.clearUnread('a', { ifVersion: 1 })).resolves.toBe(false)
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: true, unreadMarkedAt: at(70), privateStateVersion: 3 })
      // cleared: false with no marker and a higher version (another device cleared it) removes the dot.
      vi.mocked(sdk.clearConversationUnread!).mockResolvedValueOnce({ conversationId: 'a', cleared: false, unreadMarkedAt: null, privateStateVersion: 4 })
      await expect(controller.clearUnread('a')).resolves.toBe(false)
      expect(sdk.clearConversationUnread).toHaveBeenLastCalledWith('a', {})
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, unreadMarkedAt: null, privateStateVersion: 4 })
      await controller.dispose()
    })

    it('keeps the count-based unread state when a marker is cleared', async () => {
      const { sdk, inbox } = listClient()
      inbox(() => page([entry('a', 50, { unreadCount: 3, ...marker(60, 1) })]))
      const controller = list(sdk)
      await controller.loadInitial()
      await expect(controller.clearUnread('a', { ifVersion: 1 })).resolves.toBe(true)
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: true, unreadCount: 3, unreadMarkedAt: null, privateStateVersion: 2 })
      await controller.dispose()
    })

    it('ignores a mutation response older than the stored summary', async () => {
      const { sdk, signals, inbox } = listClient()
      let cleared = false
      inbox(() => page([entry('a', 50, cleared ? { unreadMarkedAt: null, privateStateVersion: 2 } : {})]))
      const controller = list(sdk, { activityRefreshWindowMs: 0 })
      await controller.loadInitial()
      const held = deferred<ConversationPrivateState>()
      vi.mocked(sdk.markConversationUnread!).mockReturnValueOnce(held.promise)
      const marking = controller.markUnread('a')
      // A newer action elsewhere already removed the marker (version 2) and the activity signal delivered it.
      cleared = true
      signals.activity!()
      await flush()
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, privateStateVersion: 2 })
      held.resolve({ conversationId: 'a', unreadMarkedAt: at(60), privateStateVersion: 1 })
      await marking
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, unreadMarkedAt: null, privateStateVersion: 2 })
      // An equal version carries the stored state already: a no-op that publishes nothing.
      const listener = vi.fn(); controller.subscribe(listener)
      vi.mocked(sdk.clearConversationUnread!).mockResolvedValueOnce({ conversationId: 'a', cleared: false, unreadMarkedAt: null, privateStateVersion: 2 })
      await expect(controller.clearUnread('a')).resolves.toBe(false)
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, unreadMarkedAt: null, privateStateVersion: 2 })
      expect(listener).not.toHaveBeenCalled()
      expect(controller.getSnapshot().error).toBeNull()
      await controller.dispose()
    })

    it('rejects markUnread and clearUnread for an adapter without the 0.7 members', async () => {
      const { sdk, inbox } = listClient({ unread: false })
      inbox(() => page([entry('a', 50)]))
      const controller = list(sdk)
      await controller.loadInitial()
      await expect(controller.markUnread('a')).rejects.toThrow('markConversationUnread')
      await expect(controller.clearUnread('a')).rejects.toThrow('clearConversationUnread')
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false })
      expect(controller.getSnapshot().error).toBeNull()
      await controller.dispose()
    })

    it('rejects a failed mark or clear and surfaces it through error without evicting rows', async () => {
      const { sdk, inbox } = listClient()
      inbox(() => page([entry('a', 50)]))
      const controller = list(sdk)
      await controller.loadInitial()
      vi.mocked(sdk.markConversationUnread!).mockRejectedValueOnce(status(404))
      await expect(controller.markUnread('a')).rejects.toEqual(status(404))
      expect(controller.getSnapshot().error).toEqual(status(404))
      expect(ids(controller)).toEqual(['a'])
      vi.mocked(sdk.clearConversationUnread!).mockRejectedValueOnce(status(500))
      await expect(controller.clearUnread('a')).rejects.toEqual(status(500))
      expect(controller.getSnapshot().error).toEqual(status(500))
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, privateStateVersion: 0 })
      // Only a `cleared: false` answer resolves `false`: the request succeeded and the marker moved on.
      vi.mocked(sdk.clearConversationUnread!).mockResolvedValueOnce({ conversationId: 'a', cleared: false, unreadMarkedAt: null, privateStateVersion: 1 })
      await expect(controller.clearUnread('a', { ifVersion: 0 })).resolves.toBe(false)
      expect(controller.getSnapshot().error).toEqual(status(500))
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, privateStateVersion: 1 })
      await controller.dispose()
    })

    it('drops a response that lands after the session changed hands and the next user loaded', async () => {
      const { sdk, signals, inbox } = listClient()
      inbox(() => page([entry('a', 50)]))
      const controller = list(sdk)
      await controller.loadInitial()
      const heldMark = deferred<ConversationPrivateState>()
      const heldClear = deferred<ClearUnreadResult>()
      vi.mocked(sdk.markConversationUnread!).mockReturnValueOnce(heldMark.promise)
      vi.mocked(sdk.clearConversationUnread!).mockReturnValueOnce(heldClear.promise)
      const marking = controller.markUnread('a')
      const clearing = controller.clearUnread('a')
      // The session ends, a different user connects and the host reloads the list for them: room `a` is in
      // their inbox too, unmarked at version 0, so the first user's late answers would pass the version gate.
      signals.ended!()
      Object.assign(sdk, { sessionIdentity: {} })
      await controller.loadInitial()
      expect(controller.getSnapshot()).toMatchObject({ currentUserId: 'me', error: null })
      const listener = vi.fn(); controller.subscribe(listener)
      heldMark.resolve({ conversationId: 'a', unreadMarkedAt: at(60), privateStateVersion: 6 })
      heldClear.reject(status(500))
      await marking
      // The failure still rejects the caller, but the next user's snapshot never learns of it.
      await expect(clearing).rejects.toEqual(status(500))
      expect(summaryOf(controller, 'a')).toMatchObject({ isUnread: false, unreadMarkedAt: null, privateStateVersion: 0 })
      expect(controller.getSnapshot().error).toBeNull()
      expect(listener).not.toHaveBeenCalled()
      await controller.dispose()
    })

    it('refuses to send once disposed, after the session ended or under a replacement login', async () => {
      const { sdk, signals, inbox } = listClient()
      inbox(() => page([entry('a', 50)]))
      const refused = async (controller: ConversationListController) => {
        await expect(controller.markUnread('a')).rejects.toThrow('ConversationListController is not active')
        await expect(controller.clearUnread('a', { ifVersion: 1 })).rejects.toThrow('ConversationListController is not active')
        expect(sdk.markConversationUnread).not.toHaveBeenCalled()
        expect(sdk.clearConversationUnread).not.toHaveBeenCalled()
      }
      // After the session ended: the rows are gone and nothing goes out.
      const ended = list(sdk)
      await ended.loadInitial()
      signals.ended!()
      await refused(ended)
      expect(ended.getSnapshot().error).toEqual(new Error('ConvoKit session ended'))
      // Under a replacement login on the shared client (no reload yet): a private marker must never be
      // written under another user. The next loadInitial binds the new session and sends again.
      Object.assign(sdk, { sessionIdentity: {} })
      await refused(ended)
      await ended.loadInitial()
      await ended.markUnread('a')
      expect(sdk.markConversationUnread).toHaveBeenCalledTimes(1)
      expect(ended.getSnapshot().error).toBeNull()
      vi.mocked(sdk.markConversationUnread!).mockClear()
      // After dispose: the same refusal, and `error` is untouched (there is no live snapshot).
      const disposed = list(sdk)
      await disposed.loadInitial()
      await disposed.dispose()
      await refused(disposed)
      expect(disposed.getSnapshot().error).toBeNull()
      // A store that never loaded has no session to send under.
      await refused(list(sdk))
      await ended.dispose()
    })

    it('refuses to send under a replacement login on the legacy path too, where reads skip the session', async () => {
      const { sdk } = listClient({ inbox: false })
      const pageLoader = vi.fn(async () => [room('legacy')])
      const controller = list(sdk, { pageLoader })
      await controller.loadInitial()
      await controller.markUnread('legacy')
      expect(sdk.markConversationUnread).toHaveBeenCalledTimes(1)
      // The shared client now belongs to another user; the connection event that retires the store has not
      // arrived yet. Reads still run through the page loader, but no marker goes out under the new login.
      Object.assign(sdk, { sessionIdentity: {} })
      await controller.refresh()
      expect(pageLoader).toHaveBeenCalledTimes(2)
      await expect(controller.markUnread('legacy')).rejects.toThrow('ConversationListController is not active')
      await expect(controller.clearUnread('legacy')).rejects.toThrow('ConversationListController is not active')
      expect(sdk.markConversationUnread).toHaveBeenCalledTimes(1)
      expect(sdk.clearConversationUnread).not.toHaveBeenCalled()
      expect(controller.getSnapshot().error).toBeNull()
      // The next loadInitial binds the new session and sends again.
      await controller.loadInitial()
      await controller.markUnread('legacy')
      expect(sdk.markConversationUnread).toHaveBeenCalledTimes(2)
      await controller.dispose()
    })

    it('calls the adapter on the legacy path and after dispose without a summary to patch', async () => {
      const { sdk } = listClient({ inbox: false })
      vi.mocked(sdk.getConversations).mockResolvedValue([room('legacy')])
      const controller = list(sdk)
      await controller.loadInitial()
      const listener = vi.fn(); controller.subscribe(listener)
      await controller.markUnread('legacy')
      expect(sdk.markConversationUnread).toHaveBeenCalledWith('legacy')
      expect(controller.getSnapshot().summaries.size).toBe(0)
      expect(listener).not.toHaveBeenCalled()
      const held = deferred<ConversationPrivateState>()
      vi.mocked(sdk.markConversationUnread!).mockReturnValueOnce(held.promise)
      const marking = controller.markUnread('legacy')
      await controller.dispose()
      held.resolve({ conversationId: 'legacy', unreadMarkedAt: at(60), privateStateVersion: 1 })
      await marking
      expect(listener).not.toHaveBeenCalled()
    })
  })
})
