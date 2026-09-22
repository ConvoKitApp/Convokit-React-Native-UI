import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  ActivityIndicator, Alert, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View, type AlertButton,
} from 'react-native'
import type { Conversation, InboxSummary, Message, MessageMedia, Participant, ReadPosition } from '@convokitapp/react-native'
import { ComposerDraft } from './composer-draft'
import { isConvoKitPendingMessage, resolveReaderIds } from './conversation-controller'
import { useControllerState } from './hooks'
import { conversationPreview, previewBody, unreadBadge } from './inbox'
import { useConvoKitTheme } from './theme'

type AsyncAction = () => void | Promise<void>

/** Message and inbox times in the device zone. */
const formatMessageTime = (date: Date): string => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export interface ConversationRowContext {
  conversation: Conversation; index: number; onPress: () => void
  /** Present on the inbox path: the row's preview, unread count and read state. */
  summary?: InboxSummary
  /** The bound user, when the view was given one; decides the `You: ` preview prefix. */
  currentUserId?: string
}
export interface MessageRowContext {
  message: Message; chronologicalIndex: number; isCurrentUser: boolean;
  sender?: Participant; readerIds: ReadonlySet<string>
  /** 0.8: the content changed after the send (`revision > 0`); the default row shows `Edited`. */
  isEdited: boolean
  /** 0.8: whether the row may be edited / deleted here: the view was given the callback and the row is the
   * caller's own, confirmed, and the caller's role is not `READ` (or `canEditMessage` said so).
   */
  canEdit: boolean
  canDelete: boolean
  /** 0.8: present only while `canEdit`: hand the row to `onEditMessage`. */
  edit?: () => void
  /** 0.8: present only while `canDelete`: ask `confirmDelete` when the view was given one, then hand the
   * row to `onDeleteMessage`; resolves whether it was deleted. Custom rows own any other confirmation UI;
   * only the default row shows the built-in `Alert` when no `confirmDelete` is set.
   */
  remove?: () => Promise<boolean>
}
export interface MediaContext { media: MessageMedia; message: Message; isCurrentUser: boolean }

export interface ConversationListViewProps {
  conversations: readonly Conversation[]
  /** Inbox summaries by conversation id; rows without one keep the 0.5 participants/description line. */
  summaries?: ReadonlyMap<string, InboxSummary>
  /** The bound user; without it no preview gets the `You: ` prefix. */
  currentUserId?: string
  onConversationSelected(conversation: Conversation): void
  onRefresh?: AsyncAction
  onLoadMore?: AsyncAction
  isInitialLoading?: boolean; isLoadingMore?: boolean; hasMore?: boolean; error?: unknown
  renderItem?: (context: ConversationRowContext) => ReactNode
  renderSeparator?: (index: number) => ReactNode
  renderEmpty?: (retry: AsyncAction) => ReactNode
  renderLoading?: () => ReactNode
  renderError?: (error: unknown, retry: AsyncAction) => ReactNode
  renderLoadingMore?: () => ReactNode
  testID?: string
}

export function ConvoKitConversationListView(props: ConversationListViewProps): ReactElement {
  const theme = useConvoKitTheme()
  // Pull-to-refresh shows its own spinner only for the pull; background refreshes never move the list.
  const [pulling, setPulling] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const pull = props.onRefresh ? async () => {
    setPulling(true)
    try { await props.onRefresh?.() } finally { if (mounted.current) setPulling(false) }
  } : undefined
  // Inline Retry: the next page when one is pending (bypassing the end-reached guard), otherwise a refresh.
  const retryInline = props.hasMore && props.onLoadMore ? props.onLoadMore : props.onRefresh
  if (props.isInitialLoading && !props.conversations.length) {
    return <>{props.renderLoading?.() ?? <ActivityIndicator accessibilityLabel="Loading conversations" />}</>
  }
  if (props.error && !props.conversations.length) {
    return <>{props.renderError?.(props.error, props.onRefresh ?? (() => undefined)) ??
      <ErrorState error={props.error} retry={props.onRefresh} />}</>
  }
  return <FlatList
    testID={props.testID}
    data={[...props.conversations]}
    keyExtractor={item => item.id}
    contentContainerStyle={{ padding: theme.spacing.md, flexGrow: props.conversations.length ? 0 : 1 }}
    ItemSeparatorComponent={({ leadingItem }) => <>{props.renderSeparator?.(
      Math.max(0, props.conversations.indexOf(leadingItem as Conversation)),
    ) ?? <View style={{ height: theme.spacing.sm }} />}</>}
    renderItem={({ item, index }) => {
      const onPress = () => props.onConversationSelected(item)
      const summary = props.summaries?.get(item.id)
      const context: ConversationRowContext = {
        conversation: item, index, onPress,
        ...(summary ? { summary } : {}),
        ...(props.currentUserId === undefined ? {} : { currentUserId: props.currentUserId }),
      }
      return <>{props.renderItem?.(context) ?? <DefaultConversationRow {...context} />}</>
    }}
    ListEmptyComponent={() => <>{props.renderEmpty?.(props.onRefresh ?? (() => undefined)) ??
      <Text style={[styles.center, { color: theme.colors.mutedText }]}>No conversations</Text>}</>}
    ListFooterComponent={() => props.isLoadingMore
      ? <>{props.renderLoadingMore?.() ?? <ActivityIndicator accessibilityLabel="Loading more conversations" />}</>
      : props.error ? <ErrorState error={props.error} retry={retryInline} /> : null}
    refreshing={pulling || Boolean(props.isInitialLoading && props.conversations.length)}
    onRefresh={pull}
    onEndReachedThreshold={0.35}
    onEndReached={() => { if (props.hasMore && !props.isLoadingMore) void props.onLoadMore?.() }}
  />
}

function DefaultConversationRow({ conversation, onPress, summary, currentUserId }: ConversationRowContext): ReactElement {
  const theme = useConvoKitTheme()
  const preview = summary ? conversationPreview(conversation, summary, currentUserId) : null
  const badge = summary ? unreadBadge(summary) : null
  const label = badge ? `Open ${conversation.displayTitle}, ${badge.accessibilityLabel}` : `Open ${conversation.displayTitle}`
  return <Pressable
    accessibilityRole="button" accessibilityLabel={label}
    onPress={onPress} style={[styles.row, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
  >
    <Avatar label={conversation.displayTitle} imageUrl={conversation.imageUrl} />
    <View style={styles.flex}>
      <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.typography.body, fontWeight: badge ? '800' : '700' }}>{conversation.displayTitle}</Text>
      <Text numberOfLines={1} style={{ color: badge ? theme.colors.text : theme.colors.mutedText }}>
        {preview ?? (conversation.participants.map(participant => participant.name).join(', ') || conversation.description)}
      </Text>
    </View>
    {summary
      ? <View style={styles.rowMeta}>
        <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.caption }}>{formatMessageTime(summary.activityAt)}</Text>
        {!!badge && (badge.dot
          ? <View accessibilityLabel={badge.accessibilityLabel} style={[styles.dot, { backgroundColor: theme.colors.badge ?? theme.colors.primary }]} />
          : <View accessibilityLabel={badge.accessibilityLabel} style={[styles.badge, { backgroundColor: theme.colors.badge ?? theme.colors.primary }]}>
            <Text accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.badgeLabel}>{badge.label}</Text>
          </View>)}
      </View>
      : <Text style={{ color: theme.colors.mutedText, fontSize: 22 }}>›</Text>}
  </Pressable>
}

export interface MessageListViewProps {
  conversation: Conversation; messages: readonly Message[]; currentUserId: string
  /** Acknowledgement times; the fallback when a user has no read position. */
  readAtByUserId?: ReadonlyMap<string, Date>
  /** Server read positions; a user's position decides which messages they have read. */
  readPositionByUserId?: ReadonlyMap<string, ReadPosition>
  readersResolver?: (message: Message) => ReadonlySet<string>
  onLoadOlder?: AsyncAction; hasOlderMessages?: boolean; isLoadingOlder?: boolean; error?: unknown
  renderMessage?: (context: MessageRowContext) => ReactNode
  renderMedia?: (context: MediaContext) => ReactNode
  renderReadReceipt?: (message: Message, readerIds: ReadonlySet<string>) => ReactNode
  renderEmpty?: () => ReactNode; renderLoadingOlder?: () => ReactNode
  renderError?: (error: unknown, retry: AsyncAction) => ReactNode
  onAttachmentPress?: (message: Message, media: MessageMedia) => void
  reverse?: boolean; testID?: string
  /** 0.8: enter edit mode on a row. Absent means no edit action anywhere (rows render as in 0.7). */
  onEditMessage?: (message: Message) => void
  /** 0.8: delete a confirmed row; `false` reports that nothing was deleted. Absent means no delete action. */
  onDeleteMessage?: (message: Message) => boolean | void | Promise<boolean | void>
  /** 0.8: replaces the built-in eligibility (own, role not `READ`) for both actions; pending rows are
   * never eligible and the callbacks are still required.
   */
  canEditMessage?: (message: Message) => boolean
  /** 0.8: replaces the default row's built-in confirmation dialog and is the only confirmation a custom
   * row's `remove()` asks for; resolve `true` to delete.
   */
  confirmDelete?: (message: Message) => boolean | Promise<boolean>
}

/** The default row's built-in delete confirmation: an alert with `Delete` and `Cancel`; dismissing it declines. */
function confirmDeletion(): Promise<boolean> {
  return new Promise(resolve => Alert.alert(
    'Delete this message?', 'It is removed for everyone and cannot be undone.',
    [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) }, { text: 'Delete', style: 'destructive', onPress: () => resolve(true) }],
    { cancelable: true, onDismiss: () => resolve(false) },
  ))
}

export function ConvoKitMessageListView(props: MessageListViewProps): ReactElement {
  const theme = useConvoKitTheme()
  const chronological = [...props.messages]
  const data = props.reverse === false ? chronological : chronological.reverse()
  const listRef = useRef<FlatList<Message>>(null)
  const previousNewestId = useRef<string | undefined>(chronological.at(-1)?.id)
  const newest = chronological.at(-1)
  useEffect(() => {
    const previousId = previousNewestId.current
    previousNewestId.current = newest?.id
    if (!previousId || !newest || previousId === newest.id || newest.senderId !== props.currentUserId) return
    const frame = requestAnimationFrame(() => {
      if (props.reverse === false) listRef.current?.scrollToEnd({ animated: true })
      else listRef.current?.scrollToOffset({ offset: 0, animated: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [newest, props.currentUserId, props.reverse])
  const participants = new Map<string, Participant>()
  for (const participant of props.conversation.participants) {
    participants.set(participant.id, participant); participants.set(participant.appUserId, participant)
  }
  // The caller's role: the self-only `membership` (0.7 backend), else their own participants entry.
  const role = props.conversation.membership?.role ?? participants.get(props.currentUserId)?.role
  const eligible = (message: Message, mine: boolean): boolean =>
    !isConvoKitPendingMessage(message) && (props.canEditMessage ? props.canEditMessage(message) : mine && role !== 'READ')
  // The `remove()` handed to rows asks `confirmDelete` only when the host provided one; confirmation UI is
  // otherwise the row's own (the default row asks first through `inlineConfirm`).
  const remove = async (message: Message): Promise<boolean> => {
    if (props.confirmDelete && !await props.confirmDelete(message)) return false
    return (await props.onDeleteMessage?.(message)) !== false
  }
  const readers = (message: Message): ReadonlySet<string> => {
    if (isConvoKitPendingMessage(message)) return new Set()
    if (props.readersResolver) return props.readersResolver(message)
    return resolveReaderIds(message, props.readPositionByUserId, props.readAtByUserId)
  }
  const loader = props.isLoadingOlder
    ? <>{props.renderLoadingOlder?.() ?? <ActivityIndicator accessibilityLabel="Loading older messages" />}</>
    : props.error ? <>{props.renderError?.(props.error, props.onLoadOlder ?? (() => undefined)) ??
      <ErrorState error={props.error} retry={props.onLoadOlder} />}</> : null
  return <FlatList
    ref={listRef}
    testID={props.testID}
    data={data}
    inverted={props.reverse !== false}
    keyExtractor={item => item.id}
    contentContainerStyle={{ padding: theme.spacing.lg, flexGrow: data.length ? 0 : 1 }}
    maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
    ListEmptyComponent={() => <>{props.renderEmpty?.() ??
      <Text style={[styles.center, { color: theme.colors.mutedText }]}>No messages yet</Text>}</>}
    ListFooterComponent={props.reverse === false ? undefined : () => loader}
    ListHeaderComponent={props.reverse === false ? () => loader : undefined}
    onEndReachedThreshold={0.3}
    onEndReached={() => { if (props.hasOlderMessages && !props.isLoadingOlder) void props.onLoadOlder?.() }}
    renderItem={({ item }) => {
      const index = chronological.findIndex(row => row.id === item.id)
      const mine = item.senderId === props.currentUserId
      const readerIds = readers(item)
      const canEdit = Boolean(props.onEditMessage) && eligible(item, mine)
      const canDelete = Boolean(props.onDeleteMessage) && eligible(item, mine)
      const context: MessageRowContext = {
        message: item, chronologicalIndex: index, isCurrentUser: mine,
        ...(participants.get(item.senderId) ? { sender: participants.get(item.senderId)! } : {}), readerIds,
        isEdited: item.revision > 0, canEdit, canDelete,
        ...(canEdit ? { edit: () => props.onEditMessage?.(item) } : {}),
        ...(canDelete ? { remove: () => remove(item) } : {}),
      }
      return <>{props.renderMessage?.(context) ?? <DefaultMessageRow
        {...context} renderMedia={props.renderMedia} renderReadReceipt={props.renderReadReceipt}
        onAttachmentPress={props.onAttachmentPress} inlineConfirm={!props.confirmDelete}
      />}</>
    }}
  />
}

/** What `renderComposer` receives. Since 0.8 `editing` and `cancelEdit` are present while the host is in
 * edit mode: `send()` then saves the edit instead of sending, so custom composers need no branching.
 */
export interface ComposerContext {
  value: string; setValue(value: string): void; send(): void; isSending: boolean; addAttachment?: () => void
  /** The message being edited (the host's `editingMessage`). */
  editing?: Message
  /** Leave edit mode: restores the unsent draft and calls `onCancelEdit`. */
  cancelEdit?: () => void
}

export interface ConversationViewProps extends Omit<MessageListViewProps, 'conversation' | 'messages' | 'currentUserId'> {
  conversation: Conversation; messages: readonly Message[]; currentUserId: string
  typingUserIds?: ReadonlySet<string>; isInitialLoading?: boolean; isSending?: boolean
  conversationError?: unknown
  onSendMessage(input: { text: string }): boolean | Promise<boolean>
  onTypingChanged?: (typing: boolean) => void
  onBack?: () => void; onRefresh?: AsyncAction; onAddAttachment?: () => void
  renderHeader?: (conversation: Conversation, actions: { onBack?: () => void; onRefresh?: AsyncAction }) => ReactNode
  renderComposer?: (input: ComposerContext) => ReactNode
  renderTypingIndicator?: (ids: ReadonlySet<string>, nameForUser: (id: string) => string) => ReactNode
  displayNameForUser?: (id: string) => string
  /** 0.8: the host's edit session. While set the composer is in edit mode: the field is prefilled with the
   * message text (stashing the unsent draft, no typing update), the banner shows the original, and the
   * primary action saves through `onSaveEdit`. Null or absent is the 0.7 composer.
   */
  editingMessage?: Message | null
  /** 0.8: save the edit with the trimmed field text (`''` clears the caption of a message with
   * attachments). `false` keeps edit mode and the text, like `onSendMessage`; anything else restores the
   * stashed draft. A text-only message is never saved empty (the action is disabled, nothing is called).
   */
  onSaveEdit?: (message: Message, text: string) => boolean | void | Promise<boolean | void>
  /** 0.8: the user pressed Cancel; the view has already restored the stashed draft. */
  onCancelEdit?: () => void
}

export function ConvoKitConversationView(props: ConversationViewProps): ReactElement {
  const theme = useConvoKitTheme(); const submitting = useRef(false)
  const draftRef = useRef<ComposerDraft | null>(null)
  if (!draftRef.current) draftRef.current = new ComposerDraft()
  const draft = draftRef.current
  draft.onTyping = props.onTypingChanged
  const editing = props.editingMessage ?? null
  draft.sync(editing)
  const { value } = useControllerState(draft)
  const setValue = (next: string) => draft.setValue(next)
  const typingUserIds = props.typingUserIds ?? new Set<string>()
  // Save needs text, or attachments to keep when the caption is cleared; send needs text.
  const canSubmit = editing ? Boolean(value.trim()) || editing.media.length > 0 : Boolean(value.trim())
  const send = async () => {
    const text = value.trim(); if (!canSubmit || submitting.current || props.isSending) return
    submitting.current = true
    try {
      if (editing) {
        if (!props.onSaveEdit) return
        const token = draft.beginSave()
        try { draft.completeSave(token, await props.onSaveEdit(editing, text) !== false) }
        catch (error) { draft.completeSave(token, false); throw error }
        return
      }
      if (await props.onSendMessage({ text })) { setValue(''); props.onTypingChanged?.(false) }
    } finally { submitting.current = false }
  }
  const cancelEdit = () => { draft.cancel(); props.onCancelEdit?.() }
  const names = (id: string) => props.displayNameForUser?.(id) ??
    props.conversation.participants.find(row => row.appUserId === id || row.id === id)?.name ?? id
  if (props.isInitialLoading && !props.messages.length) return <ActivityIndicator accessibilityLabel="Loading conversation" />
  return <View style={[styles.flex, { backgroundColor: theme.colors.background }]}>
    {props.renderHeader?.(props.conversation, { ...(props.onBack ? { onBack: props.onBack } : {}), ...(props.onRefresh ? { onRefresh: props.onRefresh } : {}) }) ??
      <View style={[styles.header, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        {!!props.onBack && <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={props.onBack}><Text style={{ color: theme.colors.primary }}>‹ Back</Text></Pressable>}
        <Avatar label={props.conversation.displayTitle} imageUrl={props.conversation.imageUrl} />
        <View style={styles.flex}>
          <Text numberOfLines={1} style={[styles.headerTitle, { color: theme.colors.text }]}>{props.conversation.displayTitle}</Text>
          <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.caption }}>{props.conversation.participants.length} participants</Text>
        </View>
        {!!props.onRefresh && <Pressable accessibilityRole="button" accessibilityLabel="Refresh conversation" onPress={() => void props.onRefresh?.()}><Text style={{ color: theme.colors.text, fontSize: 24 }}>↻</Text></Pressable>}
      </View>}
    {!!props.conversationError && <ErrorState error={props.conversationError} retry={props.onRefresh} />}
    <View style={styles.flex}><ConvoKitMessageListView {...props} /></View>
    {props.renderTypingIndicator?.(typingUserIds, names) ??
      (typingUserIds.size > 0 && <Text accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, color: theme.colors.mutedText }}>
        {[...typingUserIds].map(names).join(', ')} {typingUserIds.size === 1 ? 'is' : 'are'} typing…
      </Text>)}
    {props.renderComposer?.({
      value, setValue, send: () => void send(), isSending: Boolean(props.isSending),
      ...(props.onAddAttachment ? { addAttachment: props.onAddAttachment } : {}),
      ...(editing ? { editing, cancelEdit } : {}),
    }) ?? <>
      {!!editing && <View accessibilityLiveRegion="polite" style={[styles.editBanner, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <View style={styles.flex}>
          <Text style={{ color: theme.colors.primary, fontWeight: '700', fontSize: theme.typography.caption }}>Editing message</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.mutedText }}>{editing.text ?? previewBody(editing)}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel editing" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={cancelEdit}>
          <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Cancel</Text>
        </Pressable>
      </View>}
      <View style={[styles.composer, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        {/* Author edits change text only: no attachment control while editing. */}
        {!!props.onAddAttachment && !editing && <Pressable accessibilityRole="button" accessibilityLabel="Add attachment" onPress={props.onAddAttachment}><Text style={{ color: theme.colors.primary, fontSize: 24 }}>＋</Text></Pressable>}
        <TextInput
          accessibilityLabel="Message" placeholder="Write a message" value={value} multiline
          onChangeText={next => {
            setValue(next); props.onTypingChanged?.(next.trim().length > 0)
          }}
          onSubmitEditing={() => void send()}
          style={[styles.input, { color: theme.colors.text, borderColor: theme.colors.border }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Save message' : 'Send message'}
          disabled={!canSubmit || props.isSending}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => void send()}
          style={styles.sendButton}
        >
          <Text style={{ color: canSubmit ? theme.colors.primary : theme.colors.mutedText, fontWeight: '700' }}>{editing ? 'Save' : 'Send'}</Text>
        </Pressable>
      </View>
    </>}
  </View>
}

/** `inlineConfirm`: the view has no `confirmDelete`, so the row asks with the built-in dialog before `remove()`. */
function DefaultMessageRow(props: MessageRowContext & Pick<MessageListViewProps, 'renderMedia' | 'renderReadReceipt' | 'onAttachmentPress'> & { inlineConfirm: boolean }): ReactElement {
  const theme = useConvoKitTheme(); const pending = isConvoKitPendingMessage(props.message)
  const timeColor = props.isCurrentUser ? theme.colors.outgoingText : theme.colors.mutedText
  const body = <>
    <View style={[styles.bubble, {
      backgroundColor: props.isCurrentUser ? theme.colors.outgoingBubble : theme.colors.incomingBubble,
      borderColor: theme.colors.border,
    }]}>
      {!props.isCurrentUser && <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>{props.sender?.name ?? props.message.senderId}</Text>}
      {!!props.message.text && <Text style={{ color: props.isCurrentUser ? theme.colors.outgoingText : theme.colors.text }}>{props.message.text}</Text>}
      {props.message.media.map((media, index) => <View key={media.id ?? `${media.type}-${index}`} style={{ marginTop: theme.spacing.sm }}>
        {props.renderMedia?.({ media, message: props.message, isCurrentUser: props.isCurrentUser }) ??
          <DefaultMedia media={media} onPress={() => props.onAttachmentPress?.(props.message, media)} />}
      </View>)}
      {props.isEdited
        ? <View style={styles.meta}>
          <Text style={{ color: timeColor, opacity: 0.75, fontSize: theme.typography.caption }}>
            {pending ? 'Sending…' : formatMessageTime(props.message.createdAt)}
          </Text>
          <Text accessibilityLabel="Edited" style={{ color: timeColor, opacity: 0.75, fontSize: theme.typography.caption }}>Edited</Text>
        </View>
        : <Text style={{ color: timeColor, opacity: 0.75, fontSize: theme.typography.caption }}>
          {pending ? 'Sending…' : formatMessageTime(props.message.createdAt)}
        </Text>}
    </View>
    {props.isCurrentUser && !pending && props.readerIds.size > 0 && <>{props.renderReadReceipt?.(props.message, props.readerIds) ??
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.caption }}>Read by {props.readerIds.size}</Text>}</>}
  </>
  const layout = { alignItems: props.isCurrentUser ? 'flex-end' as const : 'flex-start' as const, marginBottom: theme.spacing.md }
  if (!props.edit && !props.remove) return <View style={layout}>{body}</View>
  // An eligible row: a long press (or the `Message actions` accessibility action) opens the action sheet.
  const remove = async () => {
    if (props.inlineConfirm && !await confirmDeletion()) return
    await props.remove?.()
  }
  const showActions = () => {
    const buttons: AlertButton[] = []
    if (props.edit) buttons.push({ text: 'Edit message', onPress: props.edit })
    if (props.remove) buttons.push({ text: 'Delete message', style: 'destructive', onPress: () => { void remove() } })
    buttons.push({ text: 'Cancel', style: 'cancel' })
    Alert.alert('Message actions', undefined, buttons, { cancelable: true })
  }
  return <Pressable
    accessibilityActions={[{ name: 'messageActions', label: 'Message actions' }]}
    onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'messageActions') showActions() }}
    accessibilityHint="Long press for message actions"
    onLongPress={showActions}
    style={layout}
  >{body}</Pressable>
}

function DefaultMedia({ media, onPress }: { media: MessageMedia; onPress(): void }): ReactElement {
  const theme = useConvoKitTheme()
  if (media.type === 'image') return <Pressable accessibilityRole="button" accessibilityLabel={media.name ?? 'Image attachment'} onPress={onPress}>
    <Image source={{ uri: media.url }} resizeMode="contain" style={styles.image} accessibilityLabel={media.name ?? 'Image attachment'} />
  </Pressable>
  const label = media.name ?? (media.type === 'location' ? 'Location' : media.type === 'contact' ? 'Contact' : 'File')
  const size = 'size' in media && media.size ? `${Math.round(media.size / 1024)} KB` : ''
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[styles.file, { borderColor: theme.colors.border }]}>
    <Text style={{ color: theme.colors.primary, fontSize: 24 }}>▱</Text>
    <View style={styles.flex}><Text style={{ color: theme.colors.text, fontWeight: '700' }}>{label}</Text>
      {!!size && <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.caption }}>{size}</Text>}</View>
    <Text style={{ color: theme.colors.mutedText, fontSize: 20 }}>⇩</Text>
  </Pressable>
}

function Avatar({ label, imageUrl }: { label: string; imageUrl: string | null }): ReactElement {
  const theme = useConvoKitTheme()
  return imageUrl ? <Image accessibilityLabel={`${label} avatar`} source={{ uri: imageUrl }} style={styles.avatar} /> :
    <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: theme.colors.primary }]}><Text style={{ color: '#fff' }}>{label.slice(0, 1).toUpperCase()}</Text></View>
}

function ErrorState({ error, retry }: { error: unknown; retry?: AsyncAction }): ReactElement {
  const theme = useConvoKitTheme()
  return <View accessibilityRole="alert" style={styles.error}><Text style={{ color: theme.colors.error }}>{error instanceof Error ? error.message : 'Something went wrong'}</Text>
    {!!retry && <Pressable accessibilityRole="button" onPress={() => void retry()}><Text style={{ color: theme.colors.primary }}>Retry</Text></Pressable>}
  </View>
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, center: { flex: 1, textAlign: 'center', textAlignVertical: 'center' },
  row: { minHeight: 68, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21 }, avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  header: { minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  editBanner: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sendButton: { minWidth: 72, minHeight: 48, paddingHorizontal: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, maxHeight: 120, minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 9 },
  bubble: { maxWidth: 520, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9, gap: 5 },
  image: { width: 240, height: 180, borderRadius: 10 }, file: { minWidth: 240, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  error: { padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowMeta: { alignItems: 'flex-end', gap: 4 },
  badge: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  badgeLabel: { color: '#fff', fontSize: 11, fontWeight: '700' },
  dot: { width: 8, height: 8, borderRadius: 4 },
})
