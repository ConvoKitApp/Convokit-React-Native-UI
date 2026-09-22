import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message, Participant } from '@convokitapp/react-native'

// E10a's jump scroll and E8a's announcement live in an effect, and `renderToStaticMarkup` never runs
// effects — the rest of the suite can only reach `onScrollToIndexFailed`, the retry, not its trigger.
// This file keeps its own harness: the React mock queues every effect a render schedules and
// `flushEffects()` runs them afterwards, by which time the mocked list has installed its handle and the
// refs hold what a real commit would have given them. It is deliberately a separate file, so mocking a
// React hook cannot reach the markup-only tests next door.
type Props = Record<string, unknown>
interface ListHandle {
  scrollToIndex: ReturnType<typeof vi.fn>
  scrollToOffset: ReturnType<typeof vi.fn>
  scrollToEnd: ReturnType<typeof vi.fn>
}
const { effects } = vi.hoisted(() => ({ effects: [] as Array<() => unknown> }))
const lists: Array<{ props: Props; handle: ListHandle }> = []
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: (effect: () => unknown) => { effects.push(effect) } }
})
vi.mock('@convokitapp/react-native', async () => {
  const { covers, readThrough } = await import('@convokitapp/sdk')
  return { createClientMessageId: () => 'client-message-id', covers, readThrough }
})
vi.mock('react-native', () => {
  const host = (tag: string) => (props: Props) =>
    createElement(tag, { 'aria-label': props.accessibilityLabel }, props.children as ReactNode)
  return {
    ActivityIndicator: host('progress'), Image: host('img'), Text: host('span'), View: host('div'),
    TextInput: host('textarea'), Pressable: host('button'),
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    Alert: { alert: vi.fn() },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    FlatList: (props: Props & {
      data: readonly unknown[]; renderItem(input: { item: unknown; index: number }): ReactNode
      ListEmptyComponent?: () => ReactNode
    }) => {
      const handle: ListHandle = { scrollToIndex: vi.fn(), scrollToOffset: vi.fn(), scrollToEnd: vi.fn() }
      const ref = props.ref as { current: ListHandle | null } | undefined
      if (ref) ref.current = handle
      lists.push({ props, handle })
      return createElement('ul', null, props.data.length
        ? props.data.map((item, index) => createElement('li', { key: index }, props.renderItem({ item, index })))
        : props.ListEmptyComponent?.())
    },
  }
})

const { AccessibilityInfo } = await import('react-native')
const { ConvoKitMessageListView } = await import('../src/components')

const participant = (appUserId: string, name: string): Participant => ({
  id: `p-${appUserId}`, appUserId, name, imageUrl: null, role: 'READ_WRITE', lastReadAt: null, readPosition: null,
})
const conversation: Conversation = {
  id: 'room', appId: 'app', title: 'Launch', displayTitle: 'Launch room', description: null, imageUrl: null,
  participants: [participant('me', 'Maya'), participant('alex', 'Alex')],
  createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'),
}
const message = (id: string, seconds: number): Message => ({
  id, conversationId: 'room', senderId: 'alex', clientMessageId: null, text: `text ${id}`, media: [],
  createdAt: new Date(Date.UTC(2026, 8, 22, 11, 0, seconds)), updatedAt: null, revision: 0,
})
const messages = [message('m1', 1), message('m2', 2), message('m3', 3)]

const render = (props: Partial<Parameters<typeof ConvoKitMessageListView>[0]>) => renderToStaticMarkup(
  <ConvoKitMessageListView conversation={conversation} currentUserId="me" messages={messages} {...props} />,
)
/** Run what the render scheduled, in the order it was scheduled, as a commit would. */
const flushEffects = () => { for (const effect of effects.splice(0)) effect() }
const announced = () => vi.mocked(AccessibilityInfo.announceForAccessibility!)

beforeEach(() => { effects.length = 0; lists.length = 0; announced().mockReset() })

describe('jumping to a row', () => {
  it('centres the highlighted row and announces the move', () => {
    render({ highlightedMessageId: 'm1' })
    const { handle } = lists[0]!
    // Nothing moves during the render itself; the scroll is a commit-time effect.
    expect(handle.scrollToIndex).not.toHaveBeenCalled()
    flushEffects()
    // Inverted by default: the rendered `data` is newest-first, so the oldest row sits at index 2.
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(1)
    expect(handle.scrollToIndex).toHaveBeenCalledWith({ index: 2, viewPosition: 0.5, animated: true })
    expect(handle.scrollToOffset).not.toHaveBeenCalled()
    // The highlight is purely visual, so the move is what is announced.
    expect(announced()).toHaveBeenCalledTimes(1)
    expect(announced()).toHaveBeenCalledWith('Showing the quoted message')
  })

  it('reads the index from the rendered data array in the upright orientation too', () => {
    render({ highlightedMessageId: 'm1', reverse: false })
    flushEffects()
    expect(lists[0]!.handle.scrollToIndex).toHaveBeenCalledWith({ index: 0, viewPosition: 0.5, animated: true })
    lists.length = 0
    effects.length = 0
    render({ highlightedMessageId: 'm3', reverse: false })
    flushEffects()
    expect(lists[0]!.handle.scrollToIndex).toHaveBeenCalledWith({ index: 2, viewPosition: 0.5, animated: true })
  })

  it('moves nothing without a highlight, or for an id the window does not hold', () => {
    render({})
    flushEffects()
    expect(lists[0]!.handle.scrollToIndex).not.toHaveBeenCalled()
    lists.length = 0
    effects.length = 0
    // A target the replacement has not rendered yet: the next render retries, this one does not scroll.
    render({ highlightedMessageId: 'not-in-this-window' })
    flushEffects()
    expect(lists[0]!.handle.scrollToIndex).not.toHaveBeenCalled()
    expect(announced()).not.toHaveBeenCalled()
  })
})
