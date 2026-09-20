import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation, Message, ReadPosition } from '@convokitapp/react-native'

// The default rows are plain React components over a handful of primitives, so static
// markup with DOM stand-ins is enough to pin their status vocabulary without a native runtime.
vi.mock('@convokitapp/react-native', async () => {
  const { covers, readThrough } = await import('@convokitapp/sdk')
  return { createClientMessageId: () => 'client-message-id', covers, readThrough }
})
vi.mock('react-native', () => {
  const host = (tag: string) => (props: Record<string, unknown>) => createElement(tag, {
    'aria-label': props.accessibilityLabel, 'data-testid': props.testID,
  }, props.children as ReactNode)
  return {
    ActivityIndicator: host('progress'), Image: host('img'), Pressable: host('button'),
    Text: host('span'), TextInput: host('textarea'), View: host('div'),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    FlatList: (props: {
      data: readonly unknown[]; renderItem(input: { item: unknown; index: number }): ReactNode
      ListEmptyComponent?: () => ReactNode; ListHeaderComponent?: () => ReactNode; ListFooterComponent?: () => ReactNode
    }) => createElement('ul', null,
      props.ListHeaderComponent?.(),
      props.data.length ? props.data.map((item, index) => createElement('li', { key: index }, props.renderItem({ item, index }))) : props.ListEmptyComponent?.(),
      props.ListFooterComponent?.()),
  }
})

const { ConvoKitMessageListView } = await import('../src/components')

const conversation: Conversation = {
  id: 'room', appId: 'app', title: 'Launch', displayTitle: 'Launch room', description: null, imageUrl: null,
  participants: [
    { id: 'me', appUserId: 'me', name: 'Maya', imageUrl: null, role: 'READ_WRITE', lastReadAt: null, readPosition: null },
    { id: 'alex', appUserId: 'alex', name: 'Alex', imageUrl: null, role: 'READ_WRITE', lastReadAt: null, readPosition: null },
    { id: 'sam', appUserId: 'sam', name: 'Sam', imageUrl: null, role: 'READ_WRITE', lastReadAt: null, readPosition: null },
  ],
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
}
const createdAt = new Date('2026-08-01T11:19:00Z')
const message = (id: string, senderId: string, text: string): Message => ({
  id, conversationId: 'room', senderId, clientMessageId: null, text, media: [], createdAt, updatedAt: null,
})
const render = (props: Partial<ComponentProps<typeof ConvoKitMessageListView>>) => renderToStaticMarkup(
  <ConvoKitMessageListView conversation={conversation} currentUserId="me" messages={[]} {...props} />,
)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ')
const time = createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const after = new Date('2026-08-01T11:30:00Z'), before = new Date('2026-08-01T11:18:59Z')
const position = (messageId: string, at: Date = createdAt): ReadPosition => ({ messageId, createdAt: at })

describe('default message status', () => {
  it('shows sending for a pending message even when a future read marker exists', () => {
    const html = text(render({
      messages: [message('convokit-pending-1', 'me', 'Pending text')],
      readAtByUserId: new Map([['alex', new Date('2100-01-01')]]),
    }))
    expect(html).toContain('Sending…')
    expect(html).not.toContain(time)
    expect(html).not.toMatch(/Read by|\bSent\b|Delivered/)
  })

  it('shows only the server time for a confirmed message without readers, never Delivered or Sent', () => {
    const html = text(render({ messages: [message('m1', 'me', 'Confirmed text')] }))
    expect(html).toContain(time)
    expect(html).not.toContain('Sending…')
    expect(html).not.toMatch(/Read by|\bSent\b|Delivered/)
  })

  it('counts readers whose read position covers the message, breaking createdAt ties by id', () => {
    const one = text(render({
      messages: [message('m2', 'me', 'Read once')],
      readPositionByUserId: new Map([['alex', position('m2')], ['sam', position('m1')]]),
    }))
    expect(one).toContain('Read by 1')
    const two = text(render({
      messages: [message('m2', 'me', 'Read twice')],
      readPositionByUserId: new Map([['alex', position('m3')], ['sam', position('m2', after)], ['me', position('m9', after)]]),
    }))
    expect(two).toContain('Read by 2')
    expect(two).not.toMatch(/\bSent\b|Delivered/)
  })

  it('still counts readers from acknowledgement times alone', () => {
    const one = text(render({ messages: [message('m1', 'me', 'Read once')], readAtByUserId: new Map([['alex', after], ['sam', before]]) }))
    expect(one).toContain('Read by 1')
    const two = text(render({ messages: [message('m1', 'me', 'Read twice')], readAtByUserId: new Map([['alex', after], ['sam', after], ['me', after]]) }))
    expect(two).toContain('Read by 2')
  })

  it('lets a read position override a later acknowledgement time and falls back without one', () => {
    const html = text(render({
      messages: [message('m2', 'me', 'Delayed')],
      readAtByUserId: new Map([['alex', after], ['sam', after]]),
      readPositionByUserId: new Map([['alex', position('m1', before)]]),
    }))
    expect(html).toContain('Read by 1')
  })

  it('renders no outgoing status on incoming messages', () => {
    const html = text(render({ messages: [message('m1', 'alex', 'Incoming text')], readAtByUserId: new Map([['me', after], ['sam', after]]) }))
    expect(html).toContain('Alex')
    expect(html).toContain(time)
    expect(html).not.toMatch(/Read by|\bSent\b|Delivered|Sending/)
  })

  it('renders a custom read receipt verbatim only once readers exist', () => {
    const renderReadReceipt = (_: Message, readerIds: ReadonlySet<string>) => <>{`Seen by ${[...readerIds].sort().join(', ')}`}</>
    const unread = text(render({ messages: [message('m1', 'me', 'Unread')], renderReadReceipt }))
    expect(unread).not.toMatch(/Seen by|Read by|\bSent\b|Delivered/)
    const read = text(render({
      messages: [message('m1', 'me', 'Read')],
      readAtByUserId: new Map([['alex', after], ['sam', before]]), readPositionByUserId: new Map([['sam', position('m1')]]),
      renderReadReceipt,
    }))
    expect(read).toContain('Seen by alex, sam')
    expect(read).not.toContain('Read by')
  })

  it('passes the same reader ids to a custom message renderer', () => {
    const seen: string[][] = []
    render({
      messages: [message('m1', 'me', 'Read')],
      readPositionByUserId: new Map([['alex', position('m1')], ['sam', position('m0')]]),
      renderMessage: ({ readerIds }) => { seen.push([...readerIds]); return null },
    })
    expect(seen).toEqual([['alex']])
  })

  it('never applies a readers resolver to pending rows', () => {
    const readersResolver = vi.fn((_: Message) => new Set(['alex', 'sam']))
    const html = text(render({
      messages: [message('convokit-pending-1', 'me', 'Pending'), message('m1', 'me', 'Confirmed')],
      readersResolver,
    }))
    expect(html.match(/Read by 2/g)).toHaveLength(1)
    expect(html).toContain('Sending…')
    expect(readersResolver.mock.calls.map(([row]) => row.id)).toEqual(['m1'])
  })
})
