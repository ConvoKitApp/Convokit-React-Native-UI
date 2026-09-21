import { createElement, type ComponentProps, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message, Participant } from '@convokitapp/react-native'
import type { ConvoKitUiClient } from '../src/client'

// Static markup over DOM stand-ins pins the 0.8 row and composer vocabulary. Pressables and the text
// input record their props so the tests can long-press, press Save/Cancel and drive the alert buttons
// without a native runtime; `Alert.alert` is a spy whose recorded buttons the tests press.
type Props = Record<string, unknown>
const pressed: Props[] = []
const inputs: Props[] = []
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
    ...(tag === 'textarea' ? { value: props.value, readOnly: true } : {}),
  }, props.children as ReactNode)
  const button = host('button'), textarea = host('textarea')
  return {
    ActivityIndicator: host('progress'), Image: host('img'), Text: host('span'), View: host('div'),
    TextInput: (props: Props) => { inputs.push(props); return textarea(props) },
    Pressable: (props: Props) => { pressed.push(props); return button(props) },
    Alert: { alert: vi.fn() },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
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

const { Alert } = await import('react-native')
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
const createdAt = new Date('2026-08-01T11:19:00Z')
const message = (id: string, senderId: string, text: string | null, revision = 0): Message => ({
  id, conversationId: 'room', senderId, clientMessageId: null, text,
  media: text === null ? [{ type: 'image', url: `https://cdn/${id}`, name: 'photo.png' }] : [], createdAt, updatedAt: null, revision,
})
const mine = message('m1', 'me', 'Mine'), theirs = message('m2', 'alex', 'Theirs'), photo = message('m3', 'me', null)
const pending = message('convokit-pending-1', 'me', 'Pending')
const list = (props: Partial<ListProps>) => renderToStaticMarkup(
  <ConvoKitMessageListView conversation={conversation} currentUserId="me" messages={[]} {...props} />,
)
const view = (props: Partial<ViewProps>) => renderToStaticMarkup(
  <ConvoKitConversationView conversation={conversation} currentUserId="me" messages={[]} onSendMessage={() => true} {...props} />,
)
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const alerts = () => vi.mocked(Alert.alert).mock.calls as unknown as Array<[string, string | undefined, AlertButtons, unknown]>
const buttons = (index: number) => alerts()[index]![2]
const press = (index: number, label: string) => buttons(index).find(button => button.text === label)!.onPress?.()
const row = () => pressed.find(props => typeof props.onLongPress === 'function')!
const button = (label: string) => pressed.find(props => props.accessibilityLabel === label)!
const callbacks = () => ({ onEditMessage: vi.fn(), onDeleteMessage: vi.fn(() => true) })

beforeEach(() => { pressed.length = 0; inputs.length = 0; vi.mocked(Alert.alert).mockReset() })

describe('default row actions', () => {
  it('renders ineligible rows byte-identically with and without the callbacks', () => {
    const readOnly = { ...conversation, membership: { role: 'READ', lastReadAt: null, readPosition: null, unreadMarkedAt: null, privateStateVersion: 0 } }
    const listed = { ...conversation, participants: [participant('me', 'Maya', 'READ'), participant('alex', 'Alex')] }
    for (const [props, rows] of [
      [{}, [theirs]], [{}, [pending]], [{ conversation: readOnly }, [mine]], [{ conversation: listed }, [mine]],
    ] as Array<[Partial<ListProps>, Message[]]>) {
      const plain = list({ ...props, messages: rows })
      expect(list({ ...props, messages: rows, ...callbacks() })).toBe(plain)
      expect(plain).not.toContain('Message actions')
      expect(plain).not.toContain('Edited')
    }
    // Without the callbacks an own confirmed row is the 0.7 row: no long press, no actions, no hint.
    const own = list({ messages: [mine] })
    expect(own).not.toContain('Message actions')
    expect(own).not.toMatch(/data-hint|data-actions/)
    expect(pressed.some(props => props.onLongPress)).toBe(false)
  })

  it('wraps an eligible row in a long-pressable with the Message actions accessibility action', () => {
    const html = list({ messages: [mine, theirs], ...callbacks() })
    expect(html).toContain('data-actions="messageActions:Message actions"')
    expect(html).toContain('data-hint="Long press for message actions"')
    expect(html.match(/data-actions=/g)).toHaveLength(1)
    expect(text(html)).toContain('Mine')
    expect(text(html)).toContain('Theirs')
    expect(row().accessibilityActions).toEqual([{ name: 'messageActions', label: 'Message actions' }])
  })

  it('shows Edited beside the time for edited rows only', () => {
    const edited = list({ messages: [{ ...mine, revision: 1 }, { ...theirs, revision: 2 }, mine] })
    expect(edited.match(/aria-label="Edited"/g)).toHaveLength(2)
    expect(edited.match(/>Edited</g)).toHaveLength(2)
    expect(text(edited).match(/Edited/g)).toHaveLength(2)
    expect(text(list({ messages: [mine, theirs] }))).not.toContain('Edited')
    const seen: RowContext[] = []
    list({ messages: [{ ...mine, revision: 3 }, mine], reverse: false, renderMessage: context => { seen.push(context); return null } })
    expect(seen.map(context => context.isEdited)).toEqual([true, false])
  })

  it('opens the action sheet on long press and on the accessibility action, routing Edit to onEditMessage', () => {
    const handlers = callbacks()
    list({ messages: [mine], ...handlers })
    ;(row().onLongPress as () => void)()
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]![0]).toBe('Message actions')
    expect(buttons(0).map(button => button.text)).toEqual(['Edit message', 'Delete message', 'Cancel'])
    press(0, 'Edit message')
    expect(handlers.onEditMessage).toHaveBeenCalledWith(mine)
    expect(handlers.onDeleteMessage).not.toHaveBeenCalled()
    ;(row().onAccessibilityAction as (event: { nativeEvent: { actionName: string } }) => void)({ nativeEvent: { actionName: 'messageActions' } })
    expect(alerts()).toHaveLength(2)
    ;(row().onAccessibilityAction as (event: { nativeEvent: { actionName: string } }) => void)({ nativeEvent: { actionName: 'activate' } })
    expect(alerts()).toHaveLength(2)
    press(1, 'Cancel')
    expect(handlers.onEditMessage).toHaveBeenCalledTimes(1)
    // Only the given callbacks appear on the sheet.
    pressed.length = 0
    list({ messages: [mine], onEditMessage: vi.fn() })
    ;(row().onLongPress as () => void)()
    expect(buttons(2).map(button => button.text)).toEqual(['Edit message', 'Cancel'])
    pressed.length = 0
    list({ messages: [mine], onDeleteMessage: vi.fn() })
    ;(row().onLongPress as () => void)()
    expect(buttons(3).map(button => button.text)).toEqual(['Delete message', 'Cancel'])
  })

  it('confirms a delete before calling onDeleteMessage; Cancel sends nothing', async () => {
    const handlers = callbacks()
    list({ messages: [mine], ...handlers })
    ;(row().onLongPress as () => void)()
    press(0, 'Delete message')
    expect(alerts()[1]![0]).toBe('Delete this message?')
    expect(alerts()[1]![1]).toContain('cannot be undone')
    expect(buttons(1).map(button => button.text)).toEqual(['Cancel', 'Delete'])
    press(1, 'Cancel')
    await flush()
    expect(handlers.onDeleteMessage).not.toHaveBeenCalled()
    ;(row().onLongPress as () => void)()
    press(2, 'Delete message')
    press(3, 'Delete')
    await flush()
    expect(handlers.onDeleteMessage).toHaveBeenCalledWith(mine)
    // Dismissing the confirmation declines too.
    ;(row().onLongPress as () => void)()
    press(4, 'Delete message')
    ;(alerts()[5]![3] as { onDismiss(): void }).onDismiss()
    await flush()
    expect(handlers.onDeleteMessage).toHaveBeenCalledTimes(1)
  })

  it('lets confirmDelete replace the built-in dialog', async () => {
    const handlers = callbacks()
    const confirmDelete = vi.fn(async (message: Message) => message.id !== 'm1')
    list({ messages: [mine], ...handlers, confirmDelete })
    ;(row().onLongPress as () => void)()
    press(0, 'Delete message')
    await flush()
    expect(confirmDelete).toHaveBeenCalledWith(mine)
    expect(alerts()).toHaveLength(1)
    expect(handlers.onDeleteMessage).not.toHaveBeenCalled()
    confirmDelete.mockResolvedValueOnce(true)
    ;(row().onLongPress as () => void)()
    press(1, 'Delete message')
    await flush()
    expect(handlers.onDeleteMessage).toHaveBeenCalledWith(mine)
  })

  it('hands the new context members to a custom renderer and honours canEditMessage', async () => {
    const handlers = callbacks()
    const seen: RowContext[] = []
    list({ messages: [mine, theirs, pending], reverse: false, ...handlers, renderMessage: context => { seen.push(context); return null } })
    expect(seen.map(context => [context.message.id, context.canEdit, context.canDelete, typeof context.edit, typeof context.remove])).toEqual([
      ['m1', true, true, 'function', 'function'], ['m2', false, false, 'undefined', 'undefined'],
      ['convokit-pending-1', false, false, 'undefined', 'undefined'],
    ])
    seen[0]!.edit!()
    expect(handlers.onEditMessage).toHaveBeenCalledWith(mine)
    const removing = seen[0]!.remove!()
    press(0, 'Delete')
    await expect(removing).resolves.toBe(true)
    expect(handlers.onDeleteMessage).toHaveBeenCalledWith(mine)
    handlers.onDeleteMessage.mockReturnValueOnce(false)
    const refused = seen[0]!.remove!()
    press(1, 'Delete')
    await expect(refused).resolves.toBe(false)
    // The override replaces own/role, never the pending or callback rules.
    const overridden: RowContext[] = []
    list({
      messages: [mine, theirs, pending], reverse: false, ...handlers, canEditMessage: message => message.senderId === 'alex',
      renderMessage: context => { overridden.push(context); return null },
    })
    expect(overridden.map(context => [context.canEdit, context.canDelete])).toEqual([[false, false], [true, true], [false, false]])
    // The 0.7 renderer signature still compiles against the widened context.
    const legacy: NonNullable<ListProps['renderMessage']> = ({ message: item, isCurrentUser }) => `${item.id}:${isCurrentUser}`
    expect(text(list({ messages: [mine], renderMessage: legacy }))).toContain('m1:true')
  })
})

describe('composer edit mode', () => {
  it('renders the 0.7 composer without an edit session', () => {
    const plain = view({ messages: [mine] })
    expect(view({ messages: [mine], editingMessage: null, onSaveEdit: vi.fn(), onCancelEdit: vi.fn() })).toBe(plain)
    expect(plain).toContain('aria-label="Send message"')
    expect(plain).not.toContain('Editing message')
    expect(plain).not.toContain('aria-label="Cancel editing"')
  })

  it('prefills the field with the message, shows the banner and swaps Send for Save without a typing update', () => {
    const onTypingChanged = vi.fn()
    const html = view({ messages: [mine], editingMessage: mine, onSaveEdit: vi.fn(), onCancelEdit: vi.fn(), onTypingChanged })
    expect(text(html)).toContain('Editing message')
    expect(text(html)).toContain('Mine')
    expect(html).toContain('data-live="polite"')
    expect(html).toContain('aria-label="Cancel editing"')
    expect(text(html)).toContain('Cancel')
    expect(html).toContain('aria-label="Save message"')
    expect(html).not.toContain('aria-label="Send message"')
    expect(text(html)).toContain('Save')
    expect(inputs[0]?.value).toBe('Mine')
    expect(button('Save message').disabled).toBeFalsy()
    expect(onTypingChanged).not.toHaveBeenCalled()
    // A caption-less media message prefills an empty field and describes the attachment in the banner.
    const media = view({ messages: [photo], editingMessage: photo })
    expect(inputs[1]?.value).toBe('')
    expect(text(media)).toContain('Editing message')
    expect(text(media)).toContain('Photo')
  })

  it('saves through onSaveEdit with the trimmed text instead of sending', async () => {
    const onSaveEdit = vi.fn(async () => true), onSendMessage = vi.fn(() => true)
    view({ messages: [mine], editingMessage: { ...mine, text: '  Mine  ' }, onSaveEdit, onSendMessage })
    ;(button('Save message').onPress as () => void)()
    await flush()
    expect(onSaveEdit).toHaveBeenCalledWith({ ...mine, text: '  Mine  ' }, 'Mine')
    expect(onSendMessage).not.toHaveBeenCalled()
    // A cleared caption saves as '' when the message has attachments.
    pressed.length = 0
    view({ messages: [photo], editingMessage: photo, onSaveEdit, onSendMessage })
    expect(button('Save message').disabled).toBeFalsy()
    ;(button('Save message').onPress as () => void)()
    await flush()
    expect(onSaveEdit).toHaveBeenLastCalledWith(photo, '')
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('disables Save for an empty text-only message and calls nothing', async () => {
    const onSaveEdit = vi.fn(), onSendMessage = vi.fn(() => true)
    const html = view({ messages: [mine], editingMessage: { ...mine, text: '   ' }, onSaveEdit, onSendMessage })
    expect(html).toContain('aria-label="Save message" data-disabled="true"')
    ;(button('Save message').onPress as () => void)()
    await flush()
    expect(onSaveEdit).not.toHaveBeenCalled()
    expect(onSendMessage).not.toHaveBeenCalled()
  })

  it('Cancel restores the stash, reports typing for it and calls onCancelEdit', () => {
    const onCancelEdit = vi.fn(), onTypingChanged = vi.fn()
    view({ messages: [mine], editingMessage: mine, onSaveEdit: vi.fn(), onCancelEdit, onTypingChanged })
    ;(button('Cancel editing').onPress as () => void)()
    expect(onCancelEdit).toHaveBeenCalledTimes(1)
    expect(onTypingChanged.mock.calls).toEqual([[false]])
  })

  it('hands editing and cancelEdit to a custom composer only in edit mode', () => {
    const seen: ComposerContext[] = []
    const renderComposer = (input: ComposerContext) => { seen.push(input); return null }
    view({ messages: [mine], renderComposer })
    view({ messages: [mine], editingMessage: mine, onSaveEdit: vi.fn(), onCancelEdit: vi.fn(), renderComposer })
    expect(Object.keys(seen[0]!).sort()).toEqual(['isSending', 'send', 'setValue', 'value'])
    expect(seen[1]).toMatchObject({ value: 'Mine', editing: mine })
    expect(typeof seen[1]?.cancelEdit).toBe('function')
  })
})

describe('bound conversation', () => {
  const subscription = () => ({ closed: false, unsubscribe: vi.fn().mockResolvedValue(undefined) })
  const client = (edits = true) => {
    const rows = [mine, theirs]
    const sdk: ConvoKitUiClient = {
      currentUserId: 'me', sessionIdentity: {},
      getConversations: vi.fn(), getConversation: vi.fn(async () => conversation),
      getMessages: vi.fn(async () => [...rows].reverse()), getMessage: vi.fn(async (id: string) => rows.find(row => row.id === id)!),
      sendMessage: vi.fn(), markConversationRead: vi.fn().mockResolvedValue(undefined), sendTyping: vi.fn().mockResolvedValue(undefined),
      ...(edits ? {
        editMessage: vi.fn(async (id: string, input: { text: string | null; revision: number }) =>
          ({ ...rows.find(row => row.id === id)!, text: input.text, revision: input.revision + 1 })),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
      } : {}),
      onConnectionEvent: vi.fn(subscription), onInboxChanged: vi.fn(subscription),
      onMessage: vi.fn(subscription), onMessageDeleted: vi.fn(subscription), onReadReceipt: vi.fn(subscription), onTyping: vi.fn(subscription),
    }
    return sdk
  }
  const bound = (controller: InstanceType<typeof ConversationController>) =>
    renderToStaticMarkup(<ConvoKitConversation conversationId="room" controller={controller} />)

  it('threads the edit session, the actions and the save/cancel/delete callbacks from the controller', async () => {
    const sdk = client()
    const controller = new ConversationController({ conversationId: 'room', client: sdk, autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    const idle = bound(controller)
    expect(idle).toContain('data-actions="messageActions:Message actions"')
    expect(idle.match(/data-actions=/g)).toHaveLength(1)
    expect(idle).not.toContain('Editing message')
    ;(row().onLongPress as () => void)()
    press(0, 'Edit message')
    expect(controller.getSnapshot().editingMessage).toEqual(mine)
    pressed.length = 0
    const editing = bound(controller)
    expect(text(editing)).toContain('Editing message')
    expect(editing).toContain('aria-label="Save message"')
    ;(button('Save message').onPress as () => void)()
    await flush()
    expect(sdk.editMessage).toHaveBeenCalledWith('m1', { text: 'Mine', revision: 0 })
    expect(controller.getSnapshot().editingMessage).toBeNull()
    expect(controller.getSnapshot().messages.find(row => row.id === 'm1')?.revision).toBe(1)
    expect(text(bound(controller))).toContain('Edited')
    controller.startEditing('m1')
    pressed.length = 0
    bound(controller)
    ;(button('Cancel editing').onPress as () => void)()
    expect(controller.getSnapshot().editingMessage).toBeNull()
    expect(sdk.sendTyping).toHaveBeenLastCalledWith({ conversationId: 'room', isTyping: false })
    pressed.length = 0
    bound(controller)
    ;(row().onLongPress as () => void)()
    press(1, 'Delete message')
    press(2, 'Delete')
    await flush()
    expect(sdk.deleteMessage).toHaveBeenCalledWith('m1')
    expect(controller.getSnapshot().messages.map(row => row.id)).toEqual(['m2'])
    await controller.dispose()
  })

  it('renders the 0.7 rows and composer for an adapter without the members', async () => {
    const controller = new ConversationController({ conversationId: 'room', client: client(false), autoLoad: false, markReadOnLoad: false })
    await controller.loadInitial()
    controller.startEditing('m1')
    const html = bound(controller)
    expect(html).not.toMatch(/data-actions|Editing message|Save message/)
    expect(html).toContain('aria-label="Send message"')
    await controller.dispose()
  })
})
