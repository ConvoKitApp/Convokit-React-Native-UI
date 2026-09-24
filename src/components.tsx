import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  AccessibilityInfo, ActivityIndicator, Alert, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View,
  type AlertButton,
} from 'react-native'
import type { Conversation, InboxSummary, Message, MessageMedia, MessageReactionSummary, Participant, ReactionUsersPage, ReadPosition } from '@convokitapp/react-native'
import { ComposerDraft } from './composer-draft'
import { isConvoKitPendingMessage, resolveReaderIds, type ReplyPreviewEntry } from './conversation-controller'
import { useControllerState } from './hooks'
import { conversationPreview, previewBody, unreadBadge } from './inbox'
import { useConvoKitTheme } from './theme'

type AsyncAction = () => void | Promise<void>

/** Message and inbox times in the device zone. */
const formatMessageTime = (date: Date): string => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** A colour at ~16% alpha: an 8-digit hex when the token is a plain 6-digit one, otherwise the colour
 * unchanged. Lets the jump highlight fall back to the themed accent without dimming the row's content.
 */
const lowOpacity = (color: string): string => /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}29` : color

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
  /** 0.9: whether the row may be quoted here: the view was given `onReplyToMessage`, the row is
   * confirmed and the caller's role is not `READ`. Unlike `canEdit` this is not restricted to the
   * caller's own rows and is never routed through `canEditMessage`: an edit-eligibility override must
   * not suppress Reply on other members' messages.
   */
  canReply: boolean
  /** 0.9: present only while `canReply`: hand the row to `onReplyToMessage`. */
  reply?: () => void
  /** 0.9: present only when `message.replyToMessageId` is set — the resolved quoted parent, or the
   * terminal `'unavailable'` when it is gone. Absent while the parent is not yet resolved, which is a
   * distinct state from `'unavailable'`: render the reference without its text, never the unavailable
   * copy.
   */
  replyPreview?: ReplyPreviewEntry
  /** 0.9: present only when `message.replyToMessageId` is set and the view was given `onJumpToMessage`:
   * show the quoted message, loading it when it is outside the window.
   */
  jumpToReplyTarget?: () => void
  reaction?: {
    summary: MessageReactionSummary | undefined
    canToggle: boolean
    toggle: (emoji: string) => Promise<boolean>
    listUsers: (emoji: string, cursor?: string) => Promise<ReactionUsersPage>
  }
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
  /** 0.9: quote a row in the composer. Absent means no reply action anywhere (rows render as in 0.8). */
  onReplyToMessage?: (message: Message) => void
  /** 0.9: the resolved quoted parents by message id, as the room controller publishes them. A key that
   * is missing is "not yet resolved" and renders the reference without its text; `'unavailable'` renders
   * the unavailable placeholder. Follows the `readAtByUserId` map idiom.
   */
  replyPreviewByMessageId?: ReadonlyMap<string, ReplyPreviewEntry>
  /** 0.9: show a message, loading it when it is outside the window. Absent means the quoted block is
   * rendered but not activatable and no jump affordance appears.
   */
  onJumpToMessage?: (messageId: string) => void
  reactionSummaries?: ReadonlyMap<string, MessageReactionSummary>
  onToggleReaction?: (message: Message, emoji: string) => Promise<boolean>
  onListReactionUsers?: (message: Message, emoji: string, cursor?: string) => Promise<ReactionUsersPage>
  reactionEmojis?: readonly string[]
  /** 0.9: the row a jump landed on; it is tinted with `colors.highlight` until the host clears it. */
  highlightedMessageId?: string | null
  /** 0.9: whether rows newer than the rendered window exist; drives the newer-edge pagination trigger,
   * exactly as `hasOlderMessages` drives the older one. Only a jumped window ever reports true.
   */
  hasNewerMessages?: boolean
  isLoadingNewer?: boolean
  onLoadNewer?: AsyncAction
  /** 0.9: a user-initiated scroll happened, so the jump highlight should be cleared. Fired only by a
   * drag, never by the programmatic scroll a jump performs.
   */
  onHighlightDismissed?: () => void
}

/** The default row's built-in delete confirmation: an alert with `Delete` and `Cancel`; dismissing it declines. */
function confirmDeletion(): Promise<boolean> {
  return new Promise(resolve => Alert.alert(
    'Delete this message?', 'It is removed for everyone and cannot be undone.',
    [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(false) }, { text: 'Delete', style: 'destructive', onPress: () => resolve(true) }],
    { cancelable: true, onDismiss: () => resolve(false) },
  ))
}

/** How many times a failed `scrollToIndex` is retried after nudging the list toward the target. Rows are
 * variable height, so there is no `getItemLayout` and the target may be outside the render window.
 */
const scrollToIndexRetries = 3

export function ConvoKitMessageListView(props: MessageListViewProps): ReactElement {
  const theme = useConvoKitTheme()
  const chronological = [...props.messages]
  // `reverse()` reverses in place and returns the same array, so `chronological` and `data` are one
  // object either way and the index below is the position in the rendered `data` array — which is what
  // `scrollToIndex` needs and what `chronologicalIndex` has always carried. 0.9.0 leaves that value as
  // it is. The map also replaces a per-row `findIndex`, which scanned the list once per row.
  const data = props.reverse === false ? chronological : chronological.reverse()
  const indexById = new Map<string, number>()
  for (let index = 0; index < data.length; index++) indexById.set(data[index]!.id, index)
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
  // The jump scroll: only an explicit `jumpToMessage` sets `highlightedMessageId`, so autoscroll, page
  // loads and live inserts never move the view this way. A target that is not rendered yet (the window
  // is still being replaced) is retried by the next render, and the ref keeps one target to one scroll.
  const highlightedId = props.highlightedMessageId ?? null
  const scrolledTo = useRef<string | null>(null)
  const retries = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(retryTimer.current), [])
  useEffect(() => {
    if (!highlightedId) { scrolledTo.current = null; return }
    if (scrolledTo.current === highlightedId) return
    const index = indexById.get(highlightedId)
    if (index === undefined) return
    scrolledTo.current = highlightedId
    retries.current = 0
    listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true })
    // The highlight is purely visual, so the move is announced instead: the platform's equivalent of
    // moving focus to the row a jump landed on.
    AccessibilityInfo.announceForAccessibility?.('Showing the quoted message')
  }, [highlightedId, indexById])
  const participants = new Map<string, Participant>()
  for (const participant of props.conversation.participants) {
    participants.set(participant.id, participant); participants.set(participant.appUserId, participant)
  }
  // The caller's role: the self-only `membership` (0.7 backend), else their own participants entry.
  const role = props.conversation.membership?.role ?? participants.get(props.currentUserId)?.role
  const eligible = (message: Message, mine: boolean): boolean =>
    !isConvoKitPendingMessage(message) && (props.canEditMessage ? props.canEditMessage(message) : mine && role !== 'READ')
  // Reply eligibility is deliberately NOT the edit predicate: any member may quote any row, so the
  // `mine` term is dropped, and the host's `canEditMessage` override is not consulted — an
  // edit-eligibility override must not suppress Reply on other members' messages.
  const replyable = (message: Message): boolean => !isConvoKitPendingMessage(message) && role !== 'READ'
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
  // The newer edge sits at the opposite end from the older one in both orientations, so its loader takes
  // the slot the older loader leaves free. Nothing renders there without a jumped window.
  const newerLoader = props.isLoadingNewer
    ? <ActivityIndicator accessibilityLabel="Loading newer messages" /> : null
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
    ListFooterComponent={props.reverse === false ? (newerLoader ? () => newerLoader : undefined) : () => loader}
    ListHeaderComponent={props.reverse === false ? () => loader : (newerLoader ? () => newerLoader : undefined)}
    onEndReachedThreshold={0.3}
    onEndReached={() => { if (props.hasOlderMessages && !props.isLoadingOlder) void props.onLoadOlder?.() }}
    onStartReachedThreshold={0.3}
    onStartReached={() => { if (props.hasNewerMessages && !props.isLoadingNewer) void props.onLoadNewer?.() }}
    onScrollBeginDrag={() => props.onHighlightDismissed?.()}
    onScrollToIndexFailed={info => {
      // Variable-height rows mean no `getItemLayout`, so a target outside the render window fails: nudge
      // to the estimated offset, let the list render that range, then try the index again a bounded
      // number of times.
      listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
      if (retries.current >= scrollToIndexRetries) return
      retries.current += 1
      clearTimeout(retryTimer.current)
      retryTimer.current = setTimeout(() => {
        listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true })
      }, 100)
    }}
    renderItem={({ item }) => {
      const index = indexById.get(item.id) ?? -1
      const mine = item.senderId === props.currentUserId
      const readerIds = readers(item)
      const canEdit = Boolean(props.onEditMessage) && eligible(item, mine)
      const canDelete = Boolean(props.onDeleteMessage) && eligible(item, mine)
      const canReply = Boolean(props.onReplyToMessage) && replyable(item)
      const parentId = item.replyToMessageId
      const preview = parentId === undefined ? undefined : props.replyPreviewByMessageId?.get(parentId)
      const reaction = props.reactionSummaries && props.onListReactionUsers && !isConvoKitPendingMessage(item) ? {
        summary: props.reactionSummaries.get(item.id),
        canToggle: role !== 'READ' && !!props.onToggleReaction,
        toggle: (emoji: string) => props.onToggleReaction?.(item, emoji) ?? Promise.resolve(false),
        listUsers: (emoji: string, cursor?: string) => props.onListReactionUsers!(item, emoji, cursor),
      } : undefined
      const context: MessageRowContext = {
        message: item, chronologicalIndex: index, isCurrentUser: mine,
        ...(participants.get(item.senderId) ? { sender: participants.get(item.senderId)! } : {}), readerIds,
        isEdited: item.revision > 0, canEdit, canDelete,
        ...(canEdit ? { edit: () => props.onEditMessage?.(item) } : {}),
        ...(canDelete ? { remove: () => remove(item) } : {}),
        canReply,
        ...(canReply ? { reply: () => props.onReplyToMessage?.(item) } : {}),
        ...(preview === undefined ? {} : { replyPreview: preview }),
        ...(parentId !== undefined && props.onJumpToMessage
          ? { jumpToReplyTarget: () => props.onJumpToMessage?.(parentId) } : {}),
        ...(reaction ? { reaction } : {}),
      }
      return <>{props.renderMessage?.(context) ?? <DefaultMessageRow
        {...context} renderMedia={props.renderMedia} renderReadReceipt={props.renderReadReceipt}
        onAttachmentPress={props.onAttachmentPress} inlineConfirm={!props.confirmDelete}
        reactionEmojis={props.reactionEmojis ?? ['👍', '❤️', '😂', '🎉', '😮', '😢']}
        isHighlighted={highlightedId === item.id}
        senderName={(id: string) => participants.get(id)?.name ?? id}
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
  /** 0.9: the message the next send quotes (the host's `replyTarget`); flat, like `editing`. Editing and
   * replying are mutually exclusive, so at most one of the two is ever present.
   */
  replying?: Message
  /** 0.9: drop the reply target; calls `onCancelReply`. Present exactly while `replying` is. */
  cancelReply?: () => void
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
  /** 0.9: the host's reply target. While set the composer shows a cancellable strip naming the quoted
   * message; the send itself carries the quote, so `onSendMessage` is unchanged. Null or absent is the
   * 0.8 composer.
   */
  replyTarget?: Message | null
  /** 0.9: the user pressed Cancel on the reply strip. */
  onCancelReply?: () => void
  /** 0.9: leave a jumped window and render the newest page again. Present only while the window is
   * jumped; the view shows the `Jump to latest` control exactly when it is given.
   */
  onReturnToLatest?: AsyncAction
}

export function ConvoKitConversationView(props: ConversationViewProps): ReactElement {
  const theme = useConvoKitTheme(); const submitting = useRef(false)
  const draftRef = useRef<ComposerDraft | null>(null)
  if (!draftRef.current) draftRef.current = new ComposerDraft()
  const draft = draftRef.current
  draft.onTyping = props.onTypingChanged
  const editing = props.editingMessage ?? null
  // Editing and replying are mutually exclusive in the store; the view honours edit mode if a host ever
  // sets both, so the composer never shows two modal states at once.
  const replying = editing ? null : props.replyTarget ?? null
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
  const cancelReply = () => props.onCancelReply?.()
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
    {!!props.onReturnToLatest && <Pressable
      accessibilityRole="button" accessibilityLabel="Jump to latest messages"
      onPress={() => void props.onReturnToLatest?.()}
      style={[styles.jumpToLatest, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
    ><Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Jump to latest</Text></Pressable>}
    {props.renderTypingIndicator?.(typingUserIds, names) ??
      (typingUserIds.size > 0 && <Text accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, color: theme.colors.mutedText }}>
        {[...typingUserIds].map(names).join(', ')} {typingUserIds.size === 1 ? 'is' : 'are'} typing…
      </Text>)}
    {props.renderComposer?.({
      value, setValue, send: () => void send(), isSending: Boolean(props.isSending),
      ...(props.onAddAttachment ? { addAttachment: props.onAddAttachment } : {}),
      ...(editing ? { editing, cancelEdit } : {}),
      ...(replying ? { replying, cancelReply } : {}),
    }) ?? <>
      {!!replying && <View accessibilityLiveRegion="polite" style={[styles.editBanner, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        <View style={styles.flex}>
          <Text style={{ color: theme.colors.primary, fontWeight: '700', fontSize: theme.typography.caption }}>Replying to {names(replying.senderId)}</Text>
          <Text numberOfLines={1} style={{ color: theme.colors.mutedText }}>{replying.text ?? previewBody(replying)}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={cancelReply}>
          <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>Cancel</Text>
        </Pressable>
      </View>}
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

/** The quoted block above a reply's text. Three branches, and the unresolved one is NOT the unavailable
 * copy: a preview that has not been resolved yet shows the reference alone, because a batch that has not
 * answered says nothing about whether the parent exists. The block stays activatable while the parent is
 * gone, so the reader can still jump to where it was.
 */
function QuotedMessage(props: {
  preview?: ReplyPreviewEntry; onPress?: () => void; senderName(id: string): string; isCurrentUser: boolean
}): ReactElement {
  const theme = useConvoKitTheme()
  const unavailable = props.preview === 'unavailable'
  const resolved = props.preview && props.preview !== 'unavailable' ? props.preview : null
  const author = resolved ? props.senderName(resolved.senderId) : null
  const body = resolved
    ? (resolved.text?.trim() || (resolved.mediaCount > 0 ? `${resolved.mediaCount} attachment${resolved.mediaCount === 1 ? '' : 's'}` : ''))
    : unavailable ? 'Original message unavailable' : ''
  const tint = props.isCurrentUser ? theme.colors.outgoingText : theme.colors.mutedText
  const label = unavailable ? 'Original message unavailable'
    : author ? `Quoted message from ${author}` : 'Quoted message'
  const quote = <View style={[styles.quote, { borderColor: props.isCurrentUser ? theme.colors.outgoingText : theme.colors.primary }]}>
    {!!author && <Text numberOfLines={1} style={{ color: tint, fontWeight: '700', fontSize: theme.typography.caption }}>{author}</Text>}
    {!!body && <Text numberOfLines={2} style={{ color: tint, fontSize: theme.typography.caption }}>{body}</Text>}
  </View>
  if (!props.onPress) return <View accessibilityLabel={label}>{quote}</View>
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={props.onPress}>{quote}</Pressable>
}

export function ReactionBar(props: { reaction: NonNullable<MessageRowContext['reaction']>; emojis?: readonly string[] }): ReactElement {
  const theme = useConvoKitTheme()
  const [picker, setPicker] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [users, setUsers] = useState<ReactionUsersPage['data']>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serial = useRef(0)
  useEffect(() => () => { serial.current++ }, [])
  const toggle = async (emoji: string) => {
    setBusy(true); setError(null)
    try {
      if (await props.reaction.toggle(emoji)) setPicker(false)
      else setError('Could not update reaction')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const loadUsers = async (emoji: string, next?: string) => {
    const request = ++serial.current
    setViewing(emoji); setBusy(true); setError(null)
    if (!next) { setUsers([]); setCursor(null) }
    try {
      const page = await props.reaction.listUsers(emoji, next)
      if (request !== serial.current) return
      setUsers(previous => next ? [...previous, ...page.data] : page.data)
      setCursor(page.nextCursor)
    } catch (cause) { if (request === serial.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (request === serial.current) setBusy(false) }
  }
  return <View accessibilityLabel="Message reactions" style={styles.reactions}>
    <View style={styles.reactionChips} accessibilityLiveRegion="polite">
      {props.reaction.summary?.reactions.map(row => <View key={row.emoji} style={[styles.reactionItem, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
        {props.reaction.canToggle ? <Pressable accessibilityRole="button" accessibilityLabel={`${row.emoji} ${row.count} reactions; ${row.reactedByMe ? 'remove mine' : 'add mine'}`}
          accessibilityState={{ selected: row.reactedByMe, disabled: busy }} disabled={busy} onPress={() => { void toggle(row.emoji) }} style={styles.reactionChip}>
          <Text style={{ color: theme.colors.text }}>{row.emoji} {row.count}</Text>
        </Pressable> : <Text style={[styles.reactionChip, { color: theme.colors.text }]}>{row.emoji} {row.count}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={`View users who reacted with ${row.emoji}`}
          onPress={() => { void loadUsers(row.emoji) }} style={styles.reactionPeople}>
          <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.caption }}>People</Text>
        </Pressable>
      </View>)}
      {props.reaction.summary?.hasMore && <Text style={{ color: theme.colors.mutedText }}>More reactions</Text>}
      {props.reaction.canToggle && <Pressable accessibilityRole="button" accessibilityLabel="Add reaction" accessibilityState={{ expanded: picker }}
        onPress={() => setPicker(value => !value)} style={[styles.reactionAdd, { borderColor: theme.colors.border }]}>
        <Text style={{ color: theme.colors.primary }}>＋</Text>
      </Pressable>}
    </View>
      {picker && props.reaction.canToggle && <View accessibilityLabel="Choose a reaction" style={styles.reactionChips}>
        {(props.emojis ?? ['👍', '❤️', '😂', '🎉', '😮', '😢']).map(emoji => <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={`React with ${emoji}`}
        disabled={busy} onPress={() => { void toggle(emoji) }} style={styles.reactionChoice}>
        <Text style={{ fontSize: 20 }}>{emoji}</Text>
      </Pressable>)}
    </View>}
    {viewing && <View accessibilityLabel={`Users who reacted with ${viewing}`} style={[styles.reactionUsers, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="Close reaction users" onPress={() => { serial.current++; setViewing(null) }}>
        <Text style={{ color: theme.colors.primary }}>Close</Text>
      </Pressable>
      {users.map(user => <Text key={user.userId} style={{ color: theme.colors.text }}>{user.name || user.userId}</Text>)}
      {!busy && users.length === 0 && !error && <Text style={{ color: theme.colors.mutedText }}>No reactions</Text>}
      {cursor && <Pressable accessibilityRole="button" accessibilityLabel="Load more reaction users" disabled={busy}
        onPress={() => { void loadUsers(viewing, cursor) }}><Text style={{ color: theme.colors.primary }}>Load more</Text></Pressable>}
    </View>}
    {error && <Text accessibilityRole="alert" style={{ color: theme.colors.error }}>{error}</Text>}
  </View>
}

/** `inlineConfirm`: the view has no `confirmDelete`, so the row asks with the built-in dialog before `remove()`. */
function DefaultMessageRow(props: MessageRowContext & Pick<MessageListViewProps, 'renderMedia' | 'renderReadReceipt' | 'onAttachmentPress'> & {
  inlineConfirm: boolean; isHighlighted?: boolean; senderName?: (id: string) => string; reactionEmojis: readonly string[]
}): ReactElement {
  const theme = useConvoKitTheme(); const pending = isConvoKitPendingMessage(props.message)
  const timeColor = props.isCurrentUser ? theme.colors.outgoingText : theme.colors.mutedText
  const senderName = props.senderName ?? ((id: string) => id)
  const body = <>
    <View style={[styles.bubble, {
      backgroundColor: props.isCurrentUser ? theme.colors.outgoingBubble : theme.colors.incomingBubble,
      borderColor: theme.colors.border,
    }]}>
      {!props.isCurrentUser && <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>{props.sender?.name ?? props.message.senderId}</Text>}
      {props.message.replyToMessageId !== undefined && <QuotedMessage
        {...(props.replyPreview === undefined ? {} : { preview: props.replyPreview })}
        {...(props.jumpToReplyTarget ? { onPress: props.jumpToReplyTarget } : {})}
        senderName={senderName} isCurrentUser={props.isCurrentUser}
      />}
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
    {props.reaction && <ReactionBar reaction={props.reaction} emojis={props.reactionEmojis} />}
    {props.isCurrentUser && !pending && props.readerIds.size > 0 && <>{props.renderReadReceipt?.(props.message, props.readerIds) ??
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.caption }}>Read by {props.readerIds.size}</Text>}</>}
  </>
  const layout = {
    alignItems: props.isCurrentUser ? 'flex-end' as const : 'flex-start' as const, marginBottom: theme.spacing.md,
    // The jump highlight: the accent at low opacity unless the theme names its own token, mirroring
    // `colors.badge`. Cleared by the host after ~2 seconds or on a user-initiated scroll.
    ...(props.isHighlighted ? {
      backgroundColor: theme.colors.highlight ?? lowOpacity(theme.colors.primary),
      borderRadius: theme.radius.md, padding: theme.spacing.xs,
    } : {}),
  }
  // A row with no action available is not long-pressable and opens no sheet: the sheet must never open
  // on `Cancel` alone.
  if (!props.edit && !props.remove && !props.reply) return <View style={layout}>{body}</View>
  const remove = async () => {
    if (props.inlineConfirm && !await confirmDeletion()) return
    await props.remove?.()
  }
  // An eligible row: a long press (or the `Message actions` accessibility action) opens the action sheet.
  const showActions = () => {
    const buttons: AlertButton[] = []
    if (props.reply) buttons.push({ text: 'Reply', onPress: props.reply })
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
  reactions: { marginTop: 4, maxWidth: 520, gap: 4 },
  reactionChips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  reactionItem: { flexDirection: 'row', alignItems: 'center', borderWidth: StyleSheet.hairlineWidth, borderRadius: 20 },
  reactionChip: { paddingVertical: 4, paddingLeft: 9, paddingRight: 5 },
  reactionPeople: { paddingVertical: 4, paddingLeft: 3, paddingRight: 9 },
  reactionAdd: { minWidth: 28, minHeight: 28, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  reactionChoice: { padding: 5 },
  reactionUsers: { padding: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, gap: 5 },
  flex: { flex: 1 }, center: { flex: 1, textAlign: 'center', textAlignVertical: 'center' },
  row: { minHeight: 68, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  avatar: { width: 42, height: 42, borderRadius: 21 }, avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  header: { minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  editBanner: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
  quote: { borderLeftWidth: 3, paddingLeft: 8, paddingVertical: 2, gap: 1 },
  jumpToLatest: { alignSelf: 'center', minHeight: 36, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, marginBottom: 6 },
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
