import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, InboxSummary, Message, MessageMedia, Participant } from '@convokitapp/react-native'

// Static markup over DOM stand-ins is enough to pin the default row vocabulary. Pressables record
// their handlers so the tests can drive Retry without a native runtime.
const pressed: Array<{ label: string; onPress?: () => void }> = []
vi.mock('@convokitapp/react-native', async () => {
  const { covers, readThrough } = await import('@convokitapp/sdk')
  return { createClientMessageId: () => 'client-message-id', covers, readThrough }
})
vi.mock('react-native', () => {
  const host = (tag: string) => (props: Record<string, unknown>) => createElement(tag, {
    'aria-label': props.accessibilityLabel, 'data-testid': props.testID,
    'data-a11y-hidden': props.accessibilityElementsHidden ? 'true' : undefined,
    'data-important': props.importantForAccessibility,
  }, props.children as ReactNode)
  const button = host('button')
  return {
    ActivityIndicator: host('progress'), Image: host('img'), Text: host('span'), TextInput: host('textarea'), View: host('div'),
    Pressable: (props: Record<string, unknown>) => {
      pressed.push({ label: String(props.accessibilityLabel ?? ''), onPress: props.onPress as (() => void) | undefined })
      return button(props)
    },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    FlatList: (props: {
      data: readonly unknown[]; renderItem(input: { item: unknown; index: number }): ReactNode
      ListEmptyComponent?: () => ReactNode; ListFooterComponent?: () => ReactNode
    }) => createElement('ul', null,
      props.data.length ? props.data.map((item, index) => createElement('li', { key: index }, props.renderItem({ item, index }))) : props.ListEmptyComponent?.(),
      props.ListFooterComponent?.()),
  }
})

const { ConvoKitConversationListView } = await import('../src/components')
const { ConvoKitConversationList } = await import('../src/bound-components')
const { ConversationListController } = await import('../src/conversation-list-controller')
type ListProps = ComponentProps<typeof ConvoKitConversationListView>
type RowContext = Parameters<NonNullable<ListProps['renderItem']>>[0]

const participant = (appUserId: string, name: string): Participant => ({
  id: `p-${appUserId}`, appUserId, name, imageUrl: null, role: 'READ_WRITE', lastReadAt: null, readPosition: null,
})
const me = participant('me', 'Me'), ana = participant('ana', 'Ana'), bo = participant('bo', 'Bo')
const conversation = (id: string, participants: Participant[]): Conversation => ({
  id, appId: 'app', title: id, displayTitle: id, description: 'Support handoff', imageUrl: null, participants,
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
})
const dm = conversation('dm', [me, ana])
const group = conversation('group', [me, ana, bo])
const activityAt = new Date('2026-08-01T11:19:00Z')
const message = (senderId: string, text: string | null, media: MessageMedia[] = []): Message => ({
  id: 'latest', conversationId: 'room', senderId, clientMessageId: null, text, media, createdAt: activityAt, updatedAt: null,
})
const summary = (overrides: Partial<InboxSummary> = {}): InboxSummary => ({
  latestMessage: null, unreadCount: 0, unreadCountCapped: false, readPosition: null, lastReadAt: null, activityAt, ...overrides,
})
const render = (props: Partial<ListProps>) => renderToStaticMarkup(
  <ConvoKitConversationListView conversations={[]} onConversationSelected={() => undefined} {...props} />,
)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
/** `currentUserId: null` renders the row without a bound user. */
const row = (room: Conversation, latest: InboxSummary, currentUserId: string | null = 'me') => text(render({
  conversations: [room], summaries: new Map([[room.id, latest]]), ...(currentUserId === null ? {} : { currentUserId }),
}))
const time = activityAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

beforeEach(() => { pressed.length = 0 })

describe('default conversation rows', () => {
  const line = (room: Conversation, latest: Message | null, currentUserId: string | null = 'me') => {
    const html = row(room, summary({ latestMessage: latest }), currentUserId)
    return html.slice(html.indexOf(room.id) + room.id.length, html.indexOf(time)).trim()
  }

  it('previews the latest message with the contract prefixes', () => {
    expect(line(dm, message('me', 'hi'))).toBe('You: hi')
    expect(line(dm, message('ana', 'hi'))).toBe('hi')
    expect(line(group, message('me', 'hi'))).toBe('You: hi')
    expect(line(group, message('ana', 'hi'))).toBe('Ana: hi')
    expect(line(group, message('zed', 'hi'))).toBe('hi')
    expect(line(conversation('group', [me, { ...ana, name: ' ' }, bo]), message('ana', 'hi'))).toBe('hi')
    // Without a bound user there is no `You:`; the group rule names the listed sender instead.
    expect(line(group, message('me', 'hi'), null)).toBe('Me: hi')
    expect(line(dm, message('me', 'hi'), null)).toBe('hi')
  })

  it('describes media-only messages', () => {
    expect(line(group, message('ana', '  ', [{ type: 'image', url: 'https://cdn/1' }]))).toBe('Ana: Photo')
    expect(line(group, message('ana', null, [{ type: 'file', url: 'https://cdn/2', name: 'report.pdf' }]))).toBe('Ana: report.pdf')
    expect(line(group, message('ana', null, [{ type: 'file', url: 'https://cdn/3' }]))).toBe('Ana: File')
    expect(line(group, message('ana', null, [{ type: 'location', metadata: { lat: 1, lng: 2 } }]))).toBe('Ana: Location')
    expect(line(group, message('ana', null, [{ type: 'contact', metadata: { phone: '1' } }]))).toBe('Ana: Contact')
  })

  it('keeps the participants line without a latest message or a body', () => {
    expect(line(group, null)).toBe('Me, Ana, Bo')
    expect(line(group, message('ana', '   '))).toBe('Me, Ana, Bo')
    const legacy = text(render({ conversations: [conversation('room', [])] }))
    expect(legacy).toContain('Support handoff')
    expect(legacy).not.toContain(time)
  })

  it('shows the activity time and no chevron on inbox rows', () => {
    expect(row(dm, summary())).toContain(time)
    expect(row(dm, summary())).not.toContain('›')
    expect(text(render({ conversations: [dm] }))).toContain('›')
  })

  it('renders the unread badge with a capped label and a real accessible count', () => {
    const zero = render({ conversations: [dm], summaries: new Map([['dm', summary()]]) })
    expect(zero).not.toContain('unread')
    expect(zero).toContain('aria-label="Open dm"')
    const five = render({ conversations: [dm], summaries: new Map([['dm', summary({ unreadCount: 5 })]]) })
    expect(five).toContain('aria-label="5 unread"')
    expect(five).toContain('aria-label="Open dm, 5 unread"')
    expect(five).toMatch(/<span data-a11y-hidden="true" data-important="no-hide-descendants">5<\/span>/)
    const hundred = render({ conversations: [dm], summaries: new Map([['dm', summary({ unreadCount: 100 })]]) })
    expect(hundred).toContain('aria-label="100 unread"')
    expect(hundred).toMatch(/data-important="no-hide-descendants">99\+<\/span>/)
    const capped = render({ conversations: [dm], summaries: new Map([['dm', summary({ unreadCount: 1000, unreadCountCapped: true })]]) })
    expect(capped).toContain('aria-label="99+ unread"')
    expect(capped).toMatch(/data-important="no-hide-descendants">99\+<\/span>/)
    expect(text(capped)).not.toContain('1000')
  })

  it('hands the summary and the bound user to a custom renderer', () => {
    const seen: RowContext[] = []
    const latest = summary({ unreadCount: 3 })
    render({
      conversations: [dm, group], summaries: new Map([['dm', latest]]), currentUserId: 'me',
      renderItem: context => { seen.push(context); return null },
    })
    expect(seen.map(context => [context.conversation.id, context.index, context.summary, context.currentUserId]))
      .toEqual([['dm', 0, latest, 'me'], ['group', 1, undefined, 'me']])
    // The 0.5 renderer signature still compiles against the widened context.
    const legacy: NonNullable<ListProps['renderItem']> = ({ conversation: room, index, onPress }) => `${room.id}:${index}:${typeof onPress}`
    expect(text(render({ conversations: [dm], renderItem: legacy }))).toContain('dm:0:function')
  })

  it('renders the loading, empty and error states', () => {
    expect(render({ isInitialLoading: true })).toContain('aria-label="Loading conversations"')
    expect(text(render({}))).toContain('No conversations')
    const error = render({ error: new Error('Offline'), onRefresh: () => undefined })
    expect(error).toContain('Offline')
    expect(text(error)).toContain('Retry')
    expect(text(render({ error: new Error('Offline') }))).not.toContain('Retry')
    expect(render({ conversations: [dm], isLoadingMore: true })).toContain('aria-label="Loading more conversations"')
  })

  it('routes the inline Retry to the next page when one is pending, otherwise to a refresh', () => {
    const onLoadMore = vi.fn(), onRefresh = vi.fn()
    const retry = () => pressed.find(button => !button.label.startsWith('Open'))?.onPress
    render({ conversations: [dm], error: new Error('Offline'), hasMore: true, onLoadMore, onRefresh })
    retry()!()
    expect(onLoadMore).toHaveBeenCalledTimes(1); expect(onRefresh).not.toHaveBeenCalled()
    pressed.length = 0
    render({ conversations: [dm], error: new Error('Offline'), hasMore: false, onLoadMore, onRefresh })
    retry()!()
    expect(onLoadMore).toHaveBeenCalledTimes(1); expect(onRefresh).toHaveBeenCalledTimes(1)
    pressed.length = 0
    render({ conversations: [dm], error: new Error('Offline'), hasMore: true, onRefresh })
    retry()!()
    expect(onRefresh).toHaveBeenCalledTimes(2)
    pressed.length = 0
    expect(text(render({ conversations: [dm], error: new Error('Offline') }))).not.toContain('Retry')
  })
})

describe('bound conversation list', () => {
  it('forwards summaries and the bound user from the controller state', async () => {
    const session = {}
    const client = {
      currentUserId: 'me', sessionIdentity: session,
      getConversations: vi.fn(), getConversation: vi.fn(), getMessages: vi.fn(), getMessage: vi.fn(), sendMessage: vi.fn(),
      markConversationRead: vi.fn(), sendTyping: vi.fn(),
      listInbox: vi.fn().mockResolvedValue({ entries: [{ conversation: group, ...summary({ latestMessage: message('me', 'hi'), unreadCount: 2 }) }], nextCursor: null }),
      onConnectionEvent: vi.fn(() => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })),
      onInboxChanged: vi.fn(() => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })),
      onInboxActivity: vi.fn(() => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })),
      onMessage: vi.fn(), onMessageDeleted: vi.fn(), onReadReceipt: vi.fn(), onTyping: vi.fn(),
    }
    const controller = new ConversationListController({ client, autoLoad: false })
    await controller.loadInitial()
    const html = renderToStaticMarkup(<ConvoKitConversationList controller={controller} onConversationSelected={() => undefined} />)
    expect(text(html)).toContain('You: hi')
    expect(html).toContain('aria-label="Open group, 2 unread"')
    await controller.dispose()
  })
})
