import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Conversation, ConversationMembership, Message, MessageContextPage, Participant, RealtimeSubscription,
  ReplyPreview,
} from '@convokitapp/react-native'
import type { ConvoKitUiClient } from '../src/client'

// The 0.8 static-markup harness, plus the imperative surface E10a needs: React 19 hands `ref` to a
// function component as an ordinary prop, so the mocked list installs a spy handle the component's own
// `listRef` then sees, and every list's props are recorded so a test can fire `onScrollToIndexFailed`.
type Props = Record<string, unknown>
interface ListHandle {
  scrollToIndex: ReturnType<typeof vi.fn>
  scrollToOffset: ReturnType<typeof vi.fn>
  scrollToEnd: ReturnType<typeof vi.fn>
}
const pressed: Props[] = []
const inputs: Props[] = []
const lists: Array<{ props: Props; handle: ListHandle }> = []
vi.mock('@convokitapp/react-native', async () => {
  const { covers, readThrough } = await import('@convokitapp/sdk')
  return { createClientMessageId: () => 'client-message-id', covers, readThrough }
})
vi.mock('react-native', () => {
  const host = (tag: string) => (props: Props) => createElement(tag, {
    'aria-label': props.accessibilityLabel, 'data-testid': props.testID, 'data-hint': props.accessibilityHint,
    'data-actions': Array.isArray(props.accessibilityActions)
      ? (props.accessibilityActions as Array<{ name: string; label: string }>).map(action => `${action.name}:${action.label}`).join(',') : undefined,
    'data-disabled': props.disabled ? 'true' : undefined, 'data-live': props.accessibilityLiveRegion,
    // Styles are not otherwise observable through static markup, and the jump highlight IS a style.
    'data-style': props.style === undefined ? undefined : JSON.stringify(props.style),
    ...(tag === 'textarea' ? { value: props.value, readOnly: true } : {}),
  }, props.children as ReactNode)
  const button = host('button'), textarea = host('textarea')
  return {
    ActivityIndicator: host('progress'), Image: host('img'), Text: host('span'), View: host('div'),
    TextInput: (props: Props) => { inputs.push(props); return textarea(props) },
    Pressable: (props: Props) => { pressed.push(props); return button(props) },
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    Alert: { alert: vi.fn() },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    FlatList: (props: Props & {
      data: readonly unknown[]; renderItem(input: { item: unknown; index: number }): ReactNode
      ListEmptyComponent?: () => ReactNode; ListHeaderComponent?: () => ReactNode; ListFooterComponent?: () => ReactNode
    }) => {
      const handle: ListHandle = { scrollToIndex: vi.fn(), scrollToOffset: vi.fn(), scrollToEnd: vi.fn() }
      const ref = props.ref as { current: ListHandle | null } | undefined
      if (ref) ref.current = handle
      lists.push({ props, handle })
      return createElement('ul', null,
        props.ListHeaderComponent?.(),
        props.data.length ? props.data.map((item, index) => createElement('li', { key: index }, props.renderItem({ item, index }))) : props.ListEmptyComponent?.(),
        props.ListFooterComponent?.())
    },
  }
})

const { Alert } = await import('react-native')
const { ConvoKitUiProvider, lightConvoKitTheme } = await import('../src/theme')
const { ConvoKitConversationView, ConvoKitMessageListView } = await import('../src/components')
const { ConvoKitConversation } = await import('../src/bound-components')
const { ConversationController } = await import('../src/conversation-controller')
type ListProps = ComponentProps<typeof ConvoKitMessageListView>
type ViewProps = ComponentProps<typeof ConvoKitConversationView>
type ComposerContext = Parameters<NonNullable<ViewProps['renderComposer']>>[0]
type RowContext = Parameters<NonNullable<ListProps['renderMessage']>>[0]
type AlertButtons = Array<{ text: string; onPress?: () => void }>

const participant = (appUserId: string, name: string, role = 'READ_WRITE'): Participant => ({
  id: `p-${appUserId}`, appUserId, name, imageUrl: null, role, lastReadAt: null, readPosition: null,
})
const conversation: Conversation = {
  id: 'room', appId: 'app', title: 'Launch', displayTitle: 'Launch room', description: null, imageUrl: null,
  participants: [participant('me', 'Maya'), participant('alex', 'Alex')],
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
}
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 22, 11, 0, seconds))
const message = (
  id: string, senderId: string, seconds: number, text: string | null = `text ${id}`, replyToMessageId?: string,
): Message => ({
  id, conversationId: 'room', senderId, clientMessageId: null, text,
  media: text === null ? [{ type: 'image', url: `https://cdn/${id}`, name: 'photo.png' }] : [],
  createdAt: at(seconds), updatedAt: null, revision: 0,
  ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
})
const preview = (row: Message, overrides: Partial<ReplyPreview> = {}): ReplyPreview => ({
  id: row.id, conversationId: row.conversationId, senderId: row.senderId, text: row.text,
  textTruncated: false, createdAt: row.createdAt, revision: row.revision, mediaCount: row.media.length, ...overrides,
})

const parent = message('m1', 'alex', 1, 'The original')
const reply = message('m2', 'me', 2, 'Quoting you', 'm1')
const plainRow = message('m3', 'alex', 3, 'No quote')
const pendingReply = { ...message('convokit-pending-1', 'me', 4, 'Sending', 'm1') }

const list = (props: Partial<ListProps>) => renderToStaticMarkup(
  <ConvoKitMessageListView conversation={conversation} currentUserId="me" messages={[]} {...props} />,
)
const view = (props: Partial<ViewProps>) => renderToStaticMarkup(
  <ConvoKitConversationView conversation={conversation} currentUserId="me" messages={[]} onSendMessage={() => true} {...props} />,
)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
/** Two turns: the preview debounce fires on a timer, then its request resolves. */
const settle = async () => { await flush(); await flush() }
const alerts = () => vi.mocked(Alert.alert).mock.calls as unknown as Array<[string, string | undefined, AlertButtons, unknown]>
const buttons = (index: number) => alerts()[index]![2]
const press = (index: number, label: string) => buttons(index).find(action => action.text === label)!.onPress?.()
const rows = () => pressed.filter(props => typeof props.onLongPress === 'function')
const labelled = (label: string) => pressed.filter(props => props.accessibilityLabel === label)

beforeEach(() => {
  pressed.length = 0; inputs.length = 0; lists.length = 0; vi.mocked(Alert.alert).mockReset()
})

describe('default row quoting', () => {
  it('renders 0.8 rows byte-identically while the reply callbacks are absent', () => {
    const plain = list({ messages: [parent, plainRow] })
    // Every new prop except the callbacks is inert on rows that carry no reference.
    expect(list({
      messages: [parent, plainRow], replyPreviewByMessageId: new Map([['m1', preview(parent)]]),
      highlightedMessageId: null, hasNewerMessages: false, isLoadingNewer: false,
      onLoadNewer: vi.fn(), onHighlightDismissed: vi.fn(), onJumpToMessage: vi.fn(),
    })).toBe(plain)
    expect(plain).not.toContain('Reply')
    expect(plain).not.toMatch(/data-hint|data-actions/)
    // Rows that are not replyable render the same with the callback as without it.
    const readOnly = { ...conversation, membership: { role: 'READ', lastReadAt: null, readPosition: null, unreadMarkedAt: null, privateStateVersion: 0 } as ConversationMembership }
    for (const props of [{ messages: [pendingReply] }, { conversation: readOnly, messages: [parent] }]) {
      expect(list({ ...props, onReplyToMessage: vi.fn() })).toBe(list(props))
    }
  })

  it('never opens the action sheet for a row with no available action', () => {
    const readOnly = { ...conversation, membership: { role: 'READ', lastReadAt: null, readPosition: null, unreadMarkedAt: null, privateStateVersion: 0 } as ConversationMembership }
    const html = list({ conversation: readOnly, messages: [parent, reply], onReplyToMessage: vi.fn(), onEditMessage: vi.fn() })
    expect(html).not.toContain('Message actions')
    expect(rows()).toHaveLength(0)
    // A pending row is never replyable either, so it keeps the plain wrapper.
    expect(list({ messages: [pendingReply], onReplyToMessage: vi.fn() })).not.toContain('data-actions')
  })

  it('offers Reply on every confirmed row, ahead of the owner-only actions', () => {
    const onReplyToMessage = vi.fn()
    // Newest-first: `parent` (alex) renders second.
    list({ messages: [parent, reply], onReplyToMessage, onEditMessage: vi.fn(), onDeleteMessage: vi.fn() })
    expect(rows()).toHaveLength(2)
    ;(rows()[0]!.onLongPress as () => void)()
    expect(buttons(0).map(action => action.text)).toEqual(['Reply', 'Edit message', 'Delete message', 'Cancel'])
    press(0, 'Reply')
    expect(onReplyToMessage).toHaveBeenCalledWith(reply)
    ;(rows()[1]!.onLongPress as () => void)()
    expect(buttons(1).map(action => action.text)).toEqual(['Reply', 'Cancel'])
    press(1, 'Reply')
    expect(onReplyToMessage).toHaveBeenLastCalledWith(parent)
  })

  it('renders the three quoted-block branches and never the unavailable copy while unresolved', () => {
    const resolved = list({ messages: [reply], replyPreviewByMessageId: new Map([['m1', preview(parent)]]) })
    expect(text(resolved)).toContain('The original')
    expect(text(resolved)).toContain('Alex')
    expect(resolved).toContain('aria-label="Quoted message from Alex"')
    const gone = list({ messages: [reply], replyPreviewByMessageId: new Map([['m1', 'unavailable' as const]]) })
    expect(text(gone)).toContain('Original message unavailable')
    expect(gone).toContain('aria-label="Original message unavailable"')
    // Not yet resolved: the reference, with no quoted text and NOT the unavailable copy.
    const waiting = list({ messages: [reply] })
    expect(waiting).toContain('aria-label="Quoted message"')
    expect(text(waiting)).not.toContain('Original message unavailable')
    expect(text(waiting)).not.toContain('The original')
    // A caption-less parent is described by its attachment count.
    const photo = message('m9', 'alex', 9, null)
    expect(text(list({ messages: [reply], replyPreviewByMessageId: new Map([['m1', preview(photo)]]) }))).toContain('1 attachment')
  })

  it('activates the quoted block through onJumpToMessage, and only when it is given', () => {
    const onJumpToMessage = vi.fn()
    list({ messages: [reply], replyPreviewByMessageId: new Map([['m1', preview(parent)]]), onJumpToMessage })
    const quote = labelled('Quoted message from Alex')
    expect(quote).toHaveLength(1)
    ;(quote[0]!.onPress as () => void)()
    expect(onJumpToMessage).toHaveBeenCalledWith('m1')
    // Unavailable keeps the reference and the jump affordance.
    pressed.length = 0
    list({ messages: [reply], replyPreviewByMessageId: new Map([['m1', 'unavailable' as const]]), onJumpToMessage })
    ;(labelled('Original message unavailable')[0]!.onPress as () => void)()
    expect(onJumpToMessage).toHaveBeenCalledTimes(2)
    pressed.length = 0
    list({ messages: [reply], replyPreviewByMessageId: new Map([['m1', preview(parent)]]) })
    expect(labelled('Quoted message from Alex')).toHaveLength(0)
  })

  it('hands flat sibling members to a custom renderer, present only where they apply', () => {
    const seen: RowContext[] = []
    list({
      messages: [parent, reply, pendingReply], reverse: false,
      onReplyToMessage: vi.fn(), onJumpToMessage: vi.fn(),
      replyPreviewByMessageId: new Map([['m1', preview(parent)]]),
      renderMessage: context => { seen.push(context); return null },
    })
    expect(seen.map(context => [
      context.message.id, context.canReply, typeof context.reply, context.replyPreview !== undefined,
      typeof context.jumpToReplyTarget,
    ])).toEqual([
      ['m1', true, 'function', false, 'undefined'],
      ['m2', true, 'function', true, 'function'],
      // A pending reply already shows its quoted block, before the send is acknowledged.
      ['convokit-pending-1', false, 'undefined', true, 'function'],
    ])
    // The override for edit eligibility must not reach Reply.
    const overridden: RowContext[] = []
    list({
      messages: [parent, reply], reverse: false, onReplyToMessage: vi.fn(), onEditMessage: vi.fn(),
      canEditMessage: () => false, renderMessage: context => { overridden.push(context); return null },
    })
    expect(overridden.map(context => [context.canEdit, context.canReply])).toEqual([[false, true], [false, true]])
  })

  it('tints only the highlighted row and reports a user-initiated scroll', () => {
    const onHighlightDismissed = vi.fn()
    const seen: string[] = []
    list({
      messages: [parent, reply], highlightedMessageId: 'm1', onHighlightDismissed,
      renderMessage: context => { seen.push(context.message.id); return null },
    })
    expect(seen).toEqual(['m2', 'm1'])
    ;(lists[0]!.props.onScrollBeginDrag as () => void)()
    expect(onHighlightDismissed).toHaveBeenCalledTimes(1)
    // The tint itself: the accent at low opacity, on the highlighted row and on no other.
    const tinted = list({ messages: [parent, reply], highlightedMessageId: 'm1' }).split('<li>')
    expect(tinted.filter(row => row.includes('#148F7829'))).toHaveLength(1)
    expect(tinted.find(row => row.includes('The original'))).toContain('#148F7829')
    expect(tinted.find(row => row.includes('Quoting you'))).not.toContain('#148F7829')
    expect(list({ messages: [parent, reply] })).not.toContain('#148F7829')
    // A theme that names the token uses it instead, exactly as `colors.badge` behaves.
    const themed = renderToStaticMarkup(
      <ConvoKitUiProvider theme={{ colors: { ...lightConvoKitTheme.colors, highlight: '#FF00FF' } }}>
        <ConvoKitMessageListView conversation={conversation} currentUserId="me" messages={[parent, reply]} highlightedMessageId="m1" />
      </ConvoKitUiProvider>,
    )
    expect(themed.match(/#FF00FF/g)).toHaveLength(1)
    expect(themed).not.toContain('#148F7829')
  })
})

describe('list paging and scrolling', () => {
  it('indexes rows by their position in the rendered data array, in both orientations', () => {
    const inverted: RowContext[] = []
    list({ messages: [parent, reply, plainRow], renderMessage: context => { inverted.push(context); return null } })
    expect(inverted.map(context => [context.message.id, context.chronologicalIndex]))
      .toEqual([['m3', 0], ['m2', 1], ['m1', 2]])
    const upright: RowContext[] = []
    list({ messages: [parent, reply, plainRow], reverse: false, renderMessage: context => { upright.push(context); return null } })
    expect(upright.map(context => [context.message.id, context.chronologicalIndex]))
      .toEqual([['m1', 0], ['m2', 1], ['m3', 2]])
  })

  it('pages the newer edge only while the window reports newer rows', () => {
    const onLoadNewer = vi.fn()
    list({ messages: [parent, reply], onLoadNewer })
    ;(lists[0]!.props.onStartReached as () => void)()
    expect(onLoadNewer).not.toHaveBeenCalled()
    lists.length = 0
    list({ messages: [parent, reply], onLoadNewer, hasNewerMessages: true })
    ;(lists[0]!.props.onStartReached as () => void)()
    expect(onLoadNewer).toHaveBeenCalledTimes(1)
    // Not while a newer page is already in flight.
    lists.length = 0
    list({ messages: [parent, reply], onLoadNewer, hasNewerMessages: true, isLoadingNewer: true })
    ;(lists[0]!.props.onStartReached as () => void)()
    expect(onLoadNewer).toHaveBeenCalledTimes(1)
  })

  it('shows the newer loader at the opposite edge from the older one', () => {
    const html = list({ messages: [parent], isLoadingNewer: true, isLoadingOlder: true })
    expect(html).toContain('aria-label="Loading newer messages"')
    expect(html).toContain('aria-label="Loading older messages"')
    expect(list({ messages: [parent] })).not.toContain('Loading newer messages')
  })

  it('recovers a failed scrollToIndex with a bounded retry', async () => {
    list({ messages: [parent, reply, plainRow] })
    const { props, handle } = lists[0]!
    const fail = props.onScrollToIndexFailed as (info: {
      index: number; highestMeasuredFrameIndex: number; averageItemLength: number
    }) => void
    for (let attempt = 0; attempt < 5; attempt++) {
      fail({ index: 2, highestMeasuredFrameIndex: 0, averageItemLength: 40 })
      await new Promise(resolve => setTimeout(resolve, 120))
    }
    // Every failure nudges to the estimated offset; only the first three re-attempt the index.
    expect(handle.scrollToOffset).toHaveBeenCalledTimes(5)
    expect(handle.scrollToOffset).toHaveBeenLastCalledWith({ offset: 80, animated: false })
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(3)
    expect(handle.scrollToIndex).toHaveBeenLastCalledWith({ index: 2, viewPosition: 0.5, animated: true })
  })
})

describe('composer reply strip', () => {
  it('renders the 0.8 composer without a reply target', () => {
    const plain = view({ messages: [parent] })
    expect(view({ messages: [parent], replyTarget: null, onCancelReply: vi.fn() })).toBe(plain)
    expect(plain).not.toContain('Replying to')
    expect(plain).not.toContain('aria-label="Cancel reply"')
  })

  it('names the quoted author and cancels through onCancelReply', () => {
    const onCancelReply = vi.fn()
    const html = view({ messages: [parent], replyTarget: parent, onCancelReply })
    expect(text(html)).toContain('Replying to Alex')
    expect(text(html)).toContain('The original')
    expect(html).toContain('data-live="polite"')
    expect(html).toContain('aria-label="Cancel reply"')
    ;(labelled('Cancel reply')[0]!.onPress as () => void)()
    expect(onCancelReply).toHaveBeenCalledTimes(1)
    // The send action is unchanged: the quote rides on the store's send, not on a new callback.
    expect(html).toContain('aria-label="Send message"')
  })

  it('keeps editing and replying mutually exclusive and hands both to a custom composer', () => {
    const editing = view({ messages: [parent], replyTarget: parent, editingMessage: parent, onSaveEdit: vi.fn() })
    expect(text(editing)).toContain('Editing message')
    expect(text(editing)).not.toContain('Replying to')
    const seen: ComposerContext[] = []
    const renderComposer = (input: ComposerContext) => { seen.push(input); return null }
    view({ messages: [parent], renderComposer })
    view({ messages: [parent], replyTarget: parent, onCancelReply: vi.fn(), renderComposer })
    expect(Object.keys(seen[0]!).sort()).toEqual(['isSending', 'send', 'setValue', 'value'])
    expect(seen[1]).toMatchObject({ replying: parent })
    expect(typeof seen[1]?.cancelReply).toBe('function')
  })

  it('shows Jump to latest exactly when onReturnToLatest is given', () => {
    const onReturnToLatest = vi.fn()
    expect(view({ messages: [parent] })).not.toContain('Jump to latest')
    const html = view({ messages: [parent], onReturnToLatest })
    expect(html).toContain('aria-label="Jump to latest messages"')
    ;(labelled('Jump to latest messages')[0]!.onPress as () => void)()
    expect(onReturnToLatest).toHaveBeenCalledTimes(1)
  })
})

/** The 0.9 adapter over an ordered `rows` array: the context endpoint serves centred and cursor windows
 * from it, the preview endpoint resolves ids that are still in it, and both record their requests.
 */
function client(rows: Message[], options: { context?: boolean | null; previews?: boolean | null } = {}) {
  const session = {}
  const handlers: {
    message?: (event: { type: 'insert' | 'update'; message: Message }) => void
    deleted?: (event: { id: string; conversationId: string }) => void
    connection?: (event: { status: string; topic: string }) => void
    inboxChanged?: () => void
  } = {}
  const close = (): RealtimeSubscription => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })
  const missing = () => Object.assign(new Error('Message not found'), { status: 404, code: 'MESSAGE_NOT_FOUND' })
  const uncoded = () => Object.assign(new Error('Cannot GET'), { status: 404, code: 'HTTP_ERROR' })
  const ordered = () => [...rows].sort((left, right) =>
    left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : 1))
  const window = (options: { messageId?: string; olderCursor?: string; newerCursor?: string; limit?: number }): MessageContextPage => {
    const all = ordered()
    const limit = options.limit ?? 30
    let slice: Message[]
    if (options.messageId !== undefined) {
      const index = all.findIndex(row => row.id === options.messageId)
      if (index === -1) throw missing()
      const end = Math.min(all.length, Math.max(index + 1, index - Math.ceil(limit / 2) + 1 + limit))
      slice = all.slice(Math.max(0, end - limit), end)
    } else if (options.olderCursor !== undefined) {
      const index = all.findIndex(row => row.id === options.olderCursor!.slice('older:'.length))
      slice = all.slice(Math.max(0, index - limit), Math.max(0, index))
    } else {
      const index = all.findIndex(row => row.id === options.newerCursor!.slice('newer:'.length))
      slice = all.slice(index + 1, index + 1 + limit)
    }
    const first = slice[0], last = slice[slice.length - 1]
    return {
      messages: [...slice].reverse(),
      olderCursor: first && all.indexOf(first) > 0 ? `older:${first.id}` : null,
      newerCursor: last && all.indexOf(last) < all.length - 1 ? `newer:${last.id}` : null,
    }
  }
  const sdk: ConvoKitUiClient = {
    currentUserId: 'me', sessionIdentity: session,
    getConversations: vi.fn().mockResolvedValue([conversation]),
    getConversation: vi.fn(async () => conversation),
    getMessages: vi.fn(async (input: { limit: number }) => ordered().reverse().slice(0, input.limit)),
    getMessage: vi.fn(async (id: string) => {
      const row = rows.find(candidate => candidate.id === id)
      if (!row) throw Object.assign(new Error('Message not found'), { status: 404 })
      return row
    }),
    sendMessage: vi.fn(async input => {
      const row: Message = {
        id: `sent-${rows.length}`, conversationId: input.conversationId, senderId: 'me',
        clientMessageId: input.clientMessageId ?? null, text: input.text ?? null, media: input.media ?? [],
        createdAt: at(90), updatedAt: null, revision: 0,
        ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
      }
      rows.push(row)
      return row
    }),
    markConversationRead: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn(async (id: string, input: { text: string | null; revision: number }) => {
      const index = rows.findIndex(candidate => candidate.id === id)
      const row = rows[index]!
      const next = { ...row, text: input.text, revision: input.revision + 1 }
      rows[index] = next
      return next
    }),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    ...(options.previews === false ? {} : {
      getReplyPreviews: vi.fn(async (_id: string, ids: string[]) => {
        if (options.previews === null) throw uncoded()
        return ids.flatMap(id => {
          const row = rows.find(candidate => candidate.id === id)
          return row ? [preview(row)] : []
        })
      }),
    }),
    ...(options.context === false ? {} : {
      getMessageContext: vi.fn(async (_id: string, input: Parameters<NonNullable<ConvoKitUiClient['getMessageContext']>>[1]) => {
        if (options.context === null) throw uncoded()
        return window(input)
      }),
    }),
    onConnectionEvent: vi.fn((handler: (event: { status: string; topic: string }) => void) => {
      handlers.connection = handler; return close()
    }),
    onInboxChanged: vi.fn((handler: () => void) => { handlers.inboxChanged = handler; return close() }),
    onMessage: vi.fn((_, handler) => { handlers.message = handler; return close() }),
    onMessageDeleted: vi.fn((_, handler) => { handlers.deleted = handler; return close() }),
    onReadReceipt: vi.fn(close), onTyping: vi.fn(close),
  }
  const previewRequests = () => vi.mocked(sdk.getReplyPreviews!).mock.calls.map(([, ids]) => ids)
  const contextRequests = () => vi.mocked(sdk.getMessageContext!).mock.calls.map(([, input]) => input)
  const targets = () => vi.mocked(sdk.markConversationRead).mock.calls.map(([, input]) => input?.throughMessageId)
  const live = {
    async insert(row: Message) {
      const index = rows.findIndex(candidate => candidate.id === row.id)
      if (index === -1) rows.push(row); else rows[index] = row
      handlers.message!({ type: 'insert', message: row }); await settle()
    },
    async update(row: Message) {
      const index = rows.findIndex(candidate => candidate.id === row.id)
      if (index !== -1) rows[index] = row
      handlers.message!({ type: 'update', message: row }); await settle()
    },
    async remove(id: string) {
      const index = rows.findIndex(candidate => candidate.id === id)
      if (index !== -1) rows.splice(index, 1)
      handlers.deleted!({ id, conversationId: 'room' }); await settle()
    },
    async rejoin() { handlers.connection!({ status: 'SUBSCRIBED', topic: 'messages:room' }); await settle() },
    async inboxChanged() { handlers.inboxChanged?.(); await settle() },
  }
  return { sdk, rows, live, previewRequests, contextRequests, targets }
}

const open = async (fixture: ReturnType<typeof client>, options: Partial<ConstructorParameters<typeof ConversationController>[0]> = {}) => {
  const controller = new ConversationController({
    conversationId: 'room', client: fixture.sdk, autoLoad: false, markReadOnLoad: false,
    replyPreviewWindowMs: 0, highlightDurationMs: 20, ...options,
  })
  await controller.loadInitial()
  await settle()
  return controller
}

describe('reply previews', () => {
  it('resolves a page of replies in one request and derives parents already in the window', async () => {
    const outside = message('m0', 'alex', 0, 'Far away')
    const fixture = client([outside, parent, message('m4', 'me', 4, 'Also quoting', 'm1'), message('m5', 'me', 5, 'Old quote', 'm0'), reply])
    const controller = await open(fixture, { messagePageSize: 4 })
    // `m1` is in the window, so it costs nothing; only `m0` is fetched, and once for two replies.
    expect(fixture.previewRequests()).toEqual([['m0']])
    const previews = controller.getSnapshot().replyPreviews
    expect(previews.get('m1')).toMatchObject({ id: 'm1', senderId: 'alex', text: 'The original', textTruncated: false })
    expect(previews.get('m0')).toMatchObject({ id: 'm0', text: 'Far away' })
    await controller.dispose()
  })

  it('batches every distinct out-of-window parent into one de-duplicated request', async () => {
    // Two distinct parents outside the window and three replies, one of which repeats a reference: a
    // per-row implementation would issue three calls, and a non-deduplicating one would send `m0` twice.
    const first = message('m0', 'alex', 0, 'First parent')
    const second = message('mA', 'alex', 1, 'Second parent')
    const fixture = client([
      first, second,
      message('r1', 'me', 5, 'Quoting the first', 'm0'),
      message('r2', 'me', 6, 'Quoting the second', 'mA'),
      message('r3', 'me', 7, 'Quoting the first again', 'm0'),
    ])
    const controller = await open(fixture, { messagePageSize: 3 })
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['r1', 'r2', 'r3'])
    // One call, two ids, first-seen order.
    expect(fixture.previewRequests()).toEqual([['m0', 'mA']])
    const previews = controller.getSnapshot().replyPreviews
    expect(previews.get('m0')).toMatchObject({ id: 'm0', text: 'First parent' })
    expect(previews.get('mA')).toMatchObject({ id: 'mA', text: 'Second parent' })
    await controller.dispose()
  })

  it('turns an out-of-window parent terminal on a delete signal, resolved or not', async () => {
    const outside = message('m0', 'alex', 0, 'Far away')
    const fixture = client([outside, message('m5', 'me', 5, 'Quote', 'm0')])
    const controller = await open(fixture, { messagePageSize: 1 })
    // The parent was never rendered: the window holds the reply alone.
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['m5'])
    expect(controller.getSnapshot().replyPreviews.get('m0')).toMatchObject({ id: 'm0' })
    await fixture.live.remove('m0')
    expect(controller.getSnapshot().replyPreviews.get('m0')).toBe('unavailable')
    await controller.refresh(); await settle()
    // Terminal: the deletion is the signal and the id is never asked for again.
    expect(fixture.previewRequests()).toEqual([['m0']])
    await controller.dispose()

    // The same signal for a parent that was never resolved either: the reference alone is what makes
    // the deletion relevant, so the terminal entry is written from `referencedParents()`.
    const bare = client([message('n0', 'alex', 0, 'Far away'), message('n5', 'me', 5, 'Quote', 'n0')], { previews: false })
    const unresolved = await open(bare, { messagePageSize: 1 })
    expect(unresolved.getSnapshot().replyPreviews.has('n0')).toBe(false)
    await bare.live.remove('n0')
    expect(unresolved.getSnapshot().replyPreviews.get('n0')).toBe('unavailable')
    await unresolved.dispose()
  })

  it('marks an out-of-window parent stale on its edit and re-reads it on the next batch', async () => {
    const outside = message('m0', 'alex', 0, 'Far away')
    const fixture = client([
      outside, message('m5', 'me', 5, 'Quote', 'm0'), message('m6', 'alex', 6, 'Filler'),
      message('m7', 'alex', 7, 'Filler too'), message('m8', 'alex', 8, 'And more'),
      message('m9', 'alex', 9, 'And more still'),
    ])
    const controller = await open(fixture, { messagePageSize: 2 })
    await controller.jumpToMessage('m5')
    expect(controller.getSnapshot().windowMode).toBe('jumped')
    expect(controller.getSnapshot().replyPreviews.get('m0')).toMatchObject({ text: 'Far away' })
    const asked = fixture.previewRequests().length
    // The parent is outside the jumped window, so its row image is recorded, not rendered: the cached
    // entry cannot be refreshed from it and is marked stale instead.
    await fixture.live.update({ ...outside, text: 'Edited far away', revision: 1 })
    expect(fixture.previewRequests()).toHaveLength(asked)
    // The next batch trigger re-reads it, because the entry is stale rather than refreshed in place.
    await controller.loadNewerMessages(); await settle()
    expect(fixture.previewRequests()).toHaveLength(asked + 1)
    expect(fixture.previewRequests().at(-1)).toEqual(['m0'])
    expect(controller.getSnapshot().replyPreviews.get('m0')).toMatchObject({ text: 'Edited far away', revision: 1 })
    await controller.dispose()
  })

  it('caches a missing id as terminal and never asks for it again', async () => {
    const fixture = client([parent, reply])
    const controller = await open(fixture)
    fixture.rows.splice(0, 1)
    await fixture.live.remove('m1')
    expect(controller.getSnapshot().replyPreviews.get('m1')).toBe('unavailable')
    await controller.refresh(); await settle()
    // A deletion is the signal; the terminal entry is never re-requested.
    expect(fixture.previewRequests()).toEqual([])
    await controller.dispose()
  })

  it('leaves the ids unresolved when the batch rejects, and asks again next time', async () => {
    const outside = message('m0', 'alex', 0, 'Far away')
    const fixture = client([outside, message('m5', 'me', 5, 'Quote', 'm0')])
    vi.mocked(fixture.sdk.getReplyPreviews!).mockRejectedValueOnce(new Error('offline'))
    const controller = await open(fixture, { messagePageSize: 1 })
    expect(controller.getSnapshot().replyPreviews.has('m0')).toBe(false)
    expect(controller.getSnapshot().error).toBeInstanceOf(Error)
    await controller.refresh(); await settle()
    expect(fixture.previewRequests()).toEqual([['m0'], ['m0']])
    expect(controller.getSnapshot().replyPreviews.get('m0')).toMatchObject({ id: 'm0' })
    await controller.dispose()
  })

  it('refreshes an in-window parent from its edit and re-reads every entry after a rejoin', async () => {
    const outside = message('m0', 'alex', 0, 'Far away')
    const fixture = client([outside, parent, message('m5', 'me', 5, 'Quote', 'm0'), reply])
    const controller = await open(fixture, { messagePageSize: 3 })
    expect(fixture.previewRequests()).toEqual([['m0']])
    await fixture.live.update({ ...parent, text: 'Edited original', revision: 1 })
    expect(controller.getSnapshot().replyPreviews.get('m1')).toMatchObject({ text: 'Edited original', revision: 1 })
    await fixture.live.rejoin()
    // The out-of-window entry is stale after a rejoin and is read again; the in-window one is derived.
    expect(fixture.previewRequests()).toEqual([['m0'], ['m0']])
    await controller.dispose()
  })

  it('issues nothing and emits nothing when a live burst is followed by dispose', async () => {
    const outside = message('m0', 'alex', 0, 'Far away')
    const fixture = client([outside, parent])
    const controller = await open(fixture, { messagePageSize: 1, replyPreviewWindowMs: 50 })
    const emits = vi.fn()
    controller.subscribe(emits)
    await fixture.live.insert(message('m6', 'alex', 6, 'Quote', 'm0'))
    await fixture.live.insert(message('m7', 'alex', 7, 'Quote too', 'm0'))
    await controller.dispose()
    emits.mockClear()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(fixture.previewRequests()).toEqual([])
    expect(emits).not.toHaveBeenCalled()
  })

  it('stops asking after a 0.8 backend answers the route with an uncoded 404, surfacing it once', async () => {
    const outside = message('m0', 'alex', 0, 'Far away')
    const fixture = client([outside, message('m5', 'me', 5, 'Quote', 'm0')], { previews: null })
    const controller = await open(fixture, { messagePageSize: 1 })
    expect(controller.getSnapshot().canResolveReplyPreviews).toBe(false)
    // E9b: the skew surfaces once through the existing error field, then the retired flag keeps it from
    // ever being raised again. The ids stay unresolved, never `unavailable`.
    expect(controller.getSnapshot().error).toBeInstanceOf(Error)
    expect(controller.getSnapshot().replyPreviews.has('m0')).toBe(false)
    await controller.refresh(); await settle()
    expect(fixture.previewRequests()).toHaveLength(1)
    // A second trigger issues no request, so there is nothing left to raise: the successful reconcile
    // cleared the surface and the failure does not come back.
    expect(controller.getSnapshot().error).toBeNull()
    await controller.dispose()
  })
})

describe('reply target and sending', () => {
  it('stamps the target on the pending row, sends it and clears the composer', async () => {
    const fixture = client([parent])
    const controller = await open(fixture)
    controller.startReply('m1')
    expect(controller.getSnapshot().replyTarget).toEqual(parent)
    const sent = controller.sendMessage({ text: 'Answer' })
    expect(controller.getSnapshot().messages.at(-1)?.replyToMessageId).toBe('m1')
    await sent
    expect(vi.mocked(fixture.sdk.sendMessage).mock.calls[0]![0]).toMatchObject({ replyToMessageId: 'm1' })
    expect(controller.getSnapshot().replyTarget).toBeNull()
    await controller.dispose()
  })

  it('omits the key entirely without a target', async () => {
    const fixture = client([parent])
    const controller = await open(fixture)
    await controller.sendMessage({ text: 'Plain' })
    expect('replyToMessageId' in vi.mocked(fixture.sdk.sendMessage).mock.calls[0]![0]).toBe(false)
    await controller.dispose()
  })

  it('refuses a pending, unknown or read-only target and swaps with edit mode', async () => {
    const fixture = client([parent, reply])
    const controller = await open(fixture)
    controller.startReply('nope')
    expect(controller.getSnapshot().replyTarget).toBeNull()
    controller.startReply('m2')
    controller.startEditing('m2')
    expect(controller.getSnapshot().replyTarget).toBeNull()
    expect(controller.getSnapshot().editingMessage).toEqual(reply)
    controller.startReply('m1')
    expect(controller.getSnapshot().editingMessage).toBeNull()
    controller.cancelReply()
    expect(controller.getSnapshot().replyTarget).toBeNull()
    await controller.dispose()
  })

  it('drops the target when that row is deleted', async () => {
    const fixture = client([parent, reply])
    const controller = await open(fixture)
    controller.startReply('m1')
    await fixture.live.remove('m1')
    expect(controller.getSnapshot().replyTarget).toBeNull()
    await controller.dispose()
  })
})

describe('jump to message', () => {
  const history = () => Array.from({ length: 12 }, (_, index) =>
    message(`h${index}`, index % 2 ? 'alex' : 'me', index, `line ${index}`))

  it('highlights a row that is already in the window without a request', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 12 })
    await expect(controller.jumpToMessage('h3')).resolves.toBe(true)
    expect(fixture.contextRequests()).toEqual([])
    expect(controller.getSnapshot().highlightedMessageId).toBe('h3')
    expect(controller.getSnapshot().windowMode).toBe('live')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(controller.getSnapshot().highlightedMessageId).toBeNull()
    await controller.dispose()
  })

  it('replaces the window, keeps the private state and stops acknowledging', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4, markReadOnLoad: true })
    await settle()
    const acknowledged = fixture.targets().length
    await expect(controller.jumpToMessage('h1')).resolves.toBe(true)
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('jumped')
    expect(state.messages.map(row => row.id)).toEqual(['h0', 'h1', 'h2', 'h3'])
    expect(state.highlightedMessageId).toBe('h1')
    expect(state.hasNewerMessages).toBe(true)
    expect(state.hasOlderMessages).toBe(false)
    // A jump is a window operation: it re-opens nothing and acknowledges nothing.
    expect(fixture.sdk.getConversation).toHaveBeenCalledTimes(1)
    await fixture.live.insert(message('h12', 'alex', 12, 'brand new'))
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['h0', 'h1', 'h2', 'h3'])
    expect(fixture.targets()).toHaveLength(acknowledged)
    await controller.dispose()
  })

  it('keeps the rows a previous jumped window recorded', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h1')
    await fixture.live.insert(message('h12', 'alex', 12, 'while away'))
    await controller.jumpToMessage('h9')
    expect(controller.getSnapshot().messages.map(row => row.id)).not.toContain('h12')
    await controller.returnToLatest()
    expect(controller.getSnapshot().messages.map(row => row.id)).toContain('h12')
    await controller.dispose()
  })

  it('rejects a malformed window and leaves the rendered rows alone', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    const before = controller.getSnapshot().messages.map(row => row.id)
    vi.mocked(fixture.sdk.getMessageContext!).mockResolvedValueOnce({
      // Oldest-first instead of newest-first: not a window this store will install.
      messages: [message('h0', 'alex', 0), message('h1', 'alex', 1)], olderCursor: null, newerCursor: null,
    })
    await expect(controller.jumpToMessage('h1')).resolves.toBe(false)
    expect(controller.getSnapshot().windowMode).toBe('live')
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(before)
    expect(controller.getSnapshot().error).toBeInstanceOf(Error)
    await controller.dispose()
  })

  it('marks the preview unavailable instead of erroring when the target is gone', async () => {
    const fixture = client([parent, reply])
    const controller = await open(fixture, { messagePageSize: 1 })
    await settle()
    fixture.rows.splice(0, 1)
    await expect(controller.jumpToMessage('m1')).resolves.toBe(false)
    expect(controller.getSnapshot().error).toBeNull()
    expect(controller.getSnapshot().replyPreviews.get('m1')).toBe('unavailable')
    expect(controller.getSnapshot().windowMode).toBe('live')
    await controller.dispose()
  })

  it('retires the affordance after a 0.8 backend answers with an uncoded 404, surfacing it once', async () => {
    const fixture = client(history(), { context: null })
    const controller = await open(fixture, { messagePageSize: 4 })
    await expect(controller.jumpToMessage('h1')).resolves.toBe(false)
    expect(controller.getSnapshot().canJumpToMessages).toBe(false)
    // E9b: the window is untouched and the failure surfaces once through the existing error field.
    const raised = controller.getSnapshot().error
    expect(raised).toBeInstanceOf(Error)
    expect(controller.getSnapshot().messages).toHaveLength(4)
    await expect(controller.jumpToMessage('h1')).resolves.toBe(false)
    // The retired flag is what makes it once: no second request, so nothing is raised a second time.
    expect(fixture.contextRequests()).toHaveLength(1)
    expect(controller.getSnapshot().error).toBe(raised)
    await controller.dispose()
  })

  it('never lets a send and a jump strand each other', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 3 })
    // E4b at entry: a jump while a send is in flight is a no-op, so no replacement can drop the
    // pending row.
    const sending = controller.sendMessage({ text: 'first' })
    await expect(controller.jumpToMessage('h2')).resolves.toBe(false)
    await sending
    expect(controller.getSnapshot().windowMode).toBe('live')
    // The same rule after the round trip, which the entry-only guard could not give: a send that
    // starts while a context page is already in flight owns a pending row in the live window, so the
    // jump abandons its replacement rather than dropping that row and merging the confirmation into a
    // historical window. The send is never the one that loses.
    const jump = controller.jumpToMessage('h2')
    const second = await controller.sendMessage({ text: 'second' })
    await expect(jump).resolves.toBe(false)
    expect(second?.text).toBe('second')
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('live')
    expect(state.messages.map(row => row.id)).toContain(second!.id)
    expect(state.messages.some(row => row.id.startsWith('convokit-pending-'))).toBe(false)
    expect(state.isSending).toBe(false)
    expect(vi.mocked(fixture.sdk.sendMessage).mock.calls).toHaveLength(2)
    await controller.dispose()
  })

  it('drops a jumped older page that answers after the return to live', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 3 })
    await controller.jumpToMessage('h2')
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['h1', 'h2', 'h3'])
    // The older page is in flight when the window goes live; its cursor belongs to a window that is
    // no longer rendered, so neither its rows nor its cursors may be installed.
    const older = controller.loadOlderMessages()
    await controller.returnToLatest()
    await older
    await settle()
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('live')
    expect(state.messages.map(row => row.id)).toEqual(['h9', 'h10', 'h11'])
    expect(state.hasOlderMessages).toBe(true)
    await controller.dispose()
  })

  it('surfaces an ordinary 404 from the live history page and keeps the jump affordance', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 3 })
    vi.mocked(fixture.sdk.getMessages).mockRejectedValueOnce(
      Object.assign(new Error('Conversation not found'), { status: 404, code: 'HTTP_ERROR' }))
    await controller.loadOlderMessages()
    // `GET /api/v1/messages` is a route every backend serves: its uncoded 404 is a membership miss,
    // never a missing 0.9 route, so it surfaces and retires nothing.
    expect(controller.getSnapshot().error).toBeInstanceOf(Error)
    expect(controller.getSnapshot().canJumpToMessages).toBe(true)
    await controller.dispose()
  })

  it('pages both ends of a jumped window through the cursors', async () => {
    // Long enough that a newer page stops short of the tail, so the window stays jumped.
    const fixture = client(Array.from({ length: 20 }, (_, index) => message(`h${index}`, 'alex', index, `line ${index}`)))
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h5')
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['h4', 'h5', 'h6', 'h7'])
    await controller.loadOlderMessages()
    expect(fixture.contextRequests().at(-1)).toMatchObject({ olderCursor: 'older:h4', limit: 4 })
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'])
    expect(controller.getSnapshot().hasOlderMessages).toBe(false)
    expect(controller.getSnapshot().hasNewerMessages).toBe(true)
    await controller.loadNewerMessages()
    expect(fixture.contextRequests().at(-1)).toMatchObject({ newerCursor: 'newer:h7', limit: 4 })
    expect(controller.getSnapshot().windowMode).toBe('jumped')
    await controller.dispose()
  })

  it('returns to the live tail rather than flipping in place when a newer page runs out', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 8 })
    await controller.jumpToMessage('h1')
    expect(controller.getSnapshot().windowMode).toBe('jumped')
    await controller.loadNewerMessages()
    await settle()
    expect(controller.getSnapshot().windowMode).toBe('live')
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(
      ['h4', 'h5', 'h6', 'h7', 'h8', 'h9', 'h10', 'h11'],
    )
    await controller.dispose()
  })
})

describe('returning to the live tail', () => {
  const history = () => Array.from({ length: 10 }, (_, index) => message(`h${index}`, 'alex', index, `line ${index}`))

  it('drains the rows it deferred and acknowledges them once rendered', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4, markReadOnLoad: true })
    await settle()
    await controller.jumpToMessage('h1')
    await fixture.live.insert(message('h10', 'alex', 10, 'while away'))
    expect(controller.getSnapshot().messages.map(row => row.id)).not.toContain('h10')
    await expect(controller.returnToLatest()).resolves.toBe(true)
    await settle()
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('live')
    expect(state.messages.map(row => row.id)).toEqual(['h7', 'h8', 'h9', 'h10'])
    expect(fixture.targets().at(-1)).toBe('h10')
    await controller.dispose()
  })

  it('keeps the jumped window intact when the reload fails', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h1')
    await fixture.live.insert(message('h10', 'alex', 10, 'while away'))
    vi.mocked(fixture.sdk.getMessages).mockRejectedValueOnce(new Error('offline'))
    await expect(controller.returnToLatest()).resolves.toBe(false)
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('jumped')
    expect(state.messages.map(row => row.id)).toEqual(['h0', 'h1', 'h2', 'h3'])
    expect(state.error).toBeInstanceOf(Error)
    // The drained row went back to the recorded set and arrives on the next successful return.
    await expect(controller.returnToLatest()).resolves.toBe(true)
    expect(controller.getSnapshot().messages.map(row => row.id)).toContain('h10')
    await controller.dispose()
  })

  it('surfaces a 404 from the reload and keeps the jump affordance', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 3 })
    await controller.jumpToMessage('h2')
    vi.mocked(fixture.sdk.getMessages).mockRejectedValueOnce(
      Object.assign(new Error('Conversation not found'), { status: 404, code: 'HTTP_ERROR' }))
    await expect(controller.returnToLatest()).resolves.toBe(false)
    // E6b: the reload is the ordinary live loader, so its failure surfaces and the affordance stays.
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('jumped')
    expect(state.error).toBeInstanceOf(Error)
    expect(state.canJumpToMessages).toBe(true)
    await controller.dispose()
  })

  it('returns to the live tail before sending, keeping the quote', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h1')
    controller.startReply('h1')
    await controller.sendMessage({ text: 'Answer' })
    expect(controller.getSnapshot().windowMode).toBe('live')
    expect(vi.mocked(fixture.sdk.sendMessage).mock.calls[0]![0]).toMatchObject({ replyToMessageId: 'h1' })
    await controller.dispose()
  })

  it('does not send, and keeps the quote, when the return fails', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h1')
    controller.startReply('h1')
    vi.mocked(fixture.sdk.getMessages).mockRejectedValueOnce(new Error('offline'))
    await expect(controller.sendMessage({ text: 'Answer' })).resolves.toBeNull()
    expect(fixture.sdk.sendMessage).not.toHaveBeenCalled()
    expect(controller.getSnapshot().isSending).toBe(false)
    expect(controller.getSnapshot().replyTarget?.id).toBe('h1')
    await controller.dispose()
  })
})

describe('reconciling a jumped window', () => {
  const history = () => Array.from({ length: 12 }, (_, index) => message(`h${index}`, 'alex', index, `line ${index}`))

  it('re-reads the window once instead of the newest page, and still owes the tail reconcile', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h1')
    const pages = vi.mocked(fixture.sdk.getMessages).mock.calls.length
    await fixture.live.inboxChanged()
    await settle()
    // One bounded, centred re-read of the window; no newest-N page while jumped.
    expect(fixture.contextRequests().at(-1)).toMatchObject({ messageId: 'h1', limit: 4 })
    expect(vi.mocked(fixture.sdk.getMessages).mock.calls).toHaveLength(pages)
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['h0', 'h1', 'h2', 'h3'])
    // The owed reconcile flushes on the return to live.
    await controller.returnToLatest()
    await settle()
    expect(vi.mocked(fixture.sdk.getMessages).mock.calls.length).toBeGreaterThan(pages + 1)
    await controller.dispose()
  })

  it('tombstones a row the centred re-read no longer returns', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h5')
    await controller.loadOlderMessages()
    expect(controller.getSnapshot().messages).toHaveLength(8)
    // The re-read spans the whole rendered window here, so every row is inside the returned range.
    fixture.rows.splice(fixture.rows.findIndex(row => row.id === 'h4'), 1)
    await fixture.live.inboxChanged()
    await settle()
    const ids = controller.getSnapshot().messages.map(row => row.id)
    expect(ids).not.toContain('h4')
    expect(ids).toContain('h0')
    expect(ids).toContain('h7')
    await controller.dispose()
  })

  it('keeps the rows outside the range the re-read returned', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 4 })
    await controller.jumpToMessage('h5')
    await controller.loadOlderMessages()
    expect(controller.getSnapshot().messages.map(row => row.id))
      .toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'])
    // Rows inserted inside the window narrow what a centred re-read of the same width can span, so the
    // newer end of the rendered window now falls OUTSIDE the returned range.
    for (const suffix of ['a', 'b', 'c', 'd']) fixture.rows.push(message(`h3${suffix}`, 'alex', 3, `line 3${suffix}`))
    // One rendered row inside the returned range is gone; the rows past its newest end are simply not
    // covered by the re-read and say nothing about whether they still exist.
    fixture.rows.splice(fixture.rows.findIndex(row => row.id === 'h2'), 1)
    await fixture.live.inboxChanged()
    await settle()
    expect(fixture.contextRequests().at(-1)).toMatchObject({ messageId: 'h3', limit: 8 })
    // `h2` is inside the range and absent: tombstoned. `h4`..`h7` are outside it and absent: kept.
    // Without E5a's range bound the four of them would be tombstoned too.
    expect(controller.getSnapshot().messages.map(row => row.id))
      .toEqual(['h0', 'h1', 'h3', 'h3a', 'h3b', 'h3c', 'h3d', 'h4', 'h5', 'h6', 'h7'])
    await controller.dispose()
  })

  it('re-reads the jumped window when a host calls refresh() directly', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 3 })
    await controller.jumpToMessage('h2')
    const pages = vi.mocked(fixture.sdk.getMessages).mock.calls.length
    const contexts = fixture.contextRequests().length
    // The default header's refresh control calls this straight through, so the E5b gate has to cover
    // it too: a newest-N page installed here would render the live tail inside a historical window.
    await controller.refresh()
    await settle()
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('jumped')
    expect(state.messages.map(row => row.id)).toEqual(['h1', 'h2', 'h3'])
    expect(vi.mocked(fixture.sdk.getMessages).mock.calls).toHaveLength(pages)
    expect(fixture.contextRequests()).toHaveLength(contexts + 1)
    expect(fixture.contextRequests().at(-1)).toMatchObject({ messageId: 'h2', limit: 3 })
    // Still owed, exactly as for a queued signal.
    await controller.returnToLatest()
    await settle()
    expect(vi.mocked(fixture.sdk.getMessages).mock.calls.length).toBeGreaterThan(pages + 1)
    await controller.dispose()
  })

  it('drops a tail reconcile that answers after a jump replaced the window', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 3 })
    const reconcile = controller.refresh()
    await controller.jumpToMessage('h2')
    await reconcile
    await settle()
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('jumped')
    expect(state.messages.map(row => row.id)).toEqual(['h1', 'h2', 'h3'])
    await controller.dispose()
  })

  it('drops a jumped re-read that answers after the return to live', async () => {
    const fixture = client(history())
    const controller = await open(fixture, { messagePageSize: 3 })
    await controller.jumpToMessage('h2')
    // The bounded re-read is in flight when the window goes live.
    void fixture.live.inboxChanged()
    await controller.returnToLatest()
    await settle()
    await settle()
    const state = controller.getSnapshot()
    expect(state.windowMode).toBe('live')
    expect(state.messages.map(row => row.id)).toEqual(['h9', 'h10', 'h11'])
    // A historical `newerCursor` installed here would leave this true for the life of the controller:
    // `loadNewerMessages` refuses to run in `live`, so nothing could ever clear it.
    expect(state.hasNewerMessages).toBe(false)
    await controller.dispose()
  })
})
