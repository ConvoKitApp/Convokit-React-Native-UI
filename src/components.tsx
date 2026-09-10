import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native'
import type { Conversation, Message, MessageMedia, Participant } from '@convokitapp/react-native'
import { isConvoKitPendingMessage } from './conversation-controller'
import { useConvoKitTheme } from './theme'

type AsyncAction = () => void | Promise<void>

export interface ConversationRowContext {
  conversation: Conversation; index: number; onPress: () => void
}
export interface MessageRowContext {
  message: Message; chronologicalIndex: number; isCurrentUser: boolean;
  sender?: Participant; readerIds: ReadonlySet<string>
}
export interface MediaContext { media: MessageMedia; message: Message; isCurrentUser: boolean }

export interface ConversationListViewProps {
  conversations: readonly Conversation[]
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
      return <>{props.renderItem?.({ conversation: item, index, onPress }) ??
        <Pressable
          accessibilityRole="button" accessibilityLabel={`Open ${item.displayTitle}`}
          onPress={onPress} style={[styles.row, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
        >
          <Avatar label={item.displayTitle} imageUrl={item.imageUrl} />
          <View style={styles.flex}>
            <Text numberOfLines={1} style={{ color: theme.colors.text, fontSize: theme.typography.body, fontWeight: '700' }}>{item.displayTitle}</Text>
            <Text numberOfLines={1} style={{ color: theme.colors.mutedText }}>
              {item.participants.map(participant => participant.name).join(', ') || item.description}
            </Text>
          </View>
          <Text style={{ color: theme.colors.mutedText, fontSize: 22 }}>›</Text>
        </Pressable>}</>
    }}
    ListEmptyComponent={() => <>{props.renderEmpty?.(props.onRefresh ?? (() => undefined)) ??
      <Text style={[styles.center, { color: theme.colors.mutedText }]}>No conversations</Text>}</>}
    ListFooterComponent={() => props.isLoadingMore
      ? <>{props.renderLoadingMore?.() ?? <ActivityIndicator accessibilityLabel="Loading more conversations" />}</>
      : props.error ? <ErrorState error={props.error} retry={props.onLoadMore} /> : null}
    refreshing={Boolean(props.isInitialLoading && props.conversations.length)}
    onRefresh={props.onRefresh}
    onEndReachedThreshold={0.35}
    onEndReached={() => { if (props.hasMore && !props.isLoadingMore) void props.onLoadMore?.() }}
  />
}

export interface MessageListViewProps {
  conversation: Conversation; messages: readonly Message[]; currentUserId: string
  readAtByUserId?: ReadonlyMap<string, Date>
  readersResolver?: (message: Message) => ReadonlySet<string>
  onLoadOlder?: AsyncAction; hasOlderMessages?: boolean; isLoadingOlder?: boolean; error?: unknown
  renderMessage?: (context: MessageRowContext) => ReactNode
  renderMedia?: (context: MediaContext) => ReactNode
  renderReadReceipt?: (message: Message, readerIds: ReadonlySet<string>) => ReactNode
  renderEmpty?: () => ReactNode; renderLoadingOlder?: () => ReactNode
  renderError?: (error: unknown, retry: AsyncAction) => ReactNode
  onAttachmentPress?: (message: Message, media: MessageMedia) => void
  reverse?: boolean; testID?: string
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
  const readers = (message: Message): ReadonlySet<string> => {
    if (props.readersResolver) return props.readersResolver(message)
    if (isConvoKitPendingMessage(message)) return new Set()
    return new Set([...(props.readAtByUserId ?? new Map())].filter(([id, at]) =>
      id !== message.senderId && at >= message.createdAt).map(([id]) => id))
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
      const context: MessageRowContext = {
        message: item, chronologicalIndex: index, isCurrentUser: mine,
        ...(participants.get(item.senderId) ? { sender: participants.get(item.senderId)! } : {}), readerIds,
      }
      return <>{props.renderMessage?.(context) ?? <DefaultMessageRow
        {...context} renderMedia={props.renderMedia} renderReadReceipt={props.renderReadReceipt}
        onAttachmentPress={props.onAttachmentPress}
      />}</>
    }}
  />
}

export interface ConversationViewProps extends Omit<MessageListViewProps, 'conversation' | 'messages' | 'currentUserId'> {
  conversation: Conversation; messages: readonly Message[]; currentUserId: string
  typingUserIds?: ReadonlySet<string>; isInitialLoading?: boolean; isSending?: boolean
  conversationError?: unknown
  onSendMessage(input: { text: string }): boolean | Promise<boolean>
  onTypingChanged?: (typing: boolean) => void
  onBack?: () => void; onRefresh?: AsyncAction; onAddAttachment?: () => void
  renderHeader?: (conversation: Conversation, actions: { onBack?: () => void; onRefresh?: AsyncAction }) => ReactNode
  renderComposer?: (input: { value: string; setValue(value: string): void; send(): void; isSending: boolean; addAttachment?: () => void }) => ReactNode
  renderTypingIndicator?: (ids: ReadonlySet<string>, nameForUser: (id: string) => string) => ReactNode
  displayNameForUser?: (id: string) => string
}

export function ConvoKitConversationView(props: ConversationViewProps): ReactElement {
  const theme = useConvoKitTheme(); const [value, setValue] = useState(''); const submitting = useRef(false)
  const typingUserIds = props.typingUserIds ?? new Set<string>()
  const send = async () => {
    const text = value.trim(); if (!text || submitting.current || props.isSending) return
    submitting.current = true
    try { if (await props.onSendMessage({ text })) { setValue(''); props.onTypingChanged?.(false) } }
    finally { submitting.current = false }
  }
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
    {props.renderComposer?.({ value, setValue, send: () => void send(), isSending: Boolean(props.isSending), ...(props.onAddAttachment ? { addAttachment: props.onAddAttachment } : {}) }) ??
      <View style={[styles.composer, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
        {!!props.onAddAttachment && <Pressable accessibilityRole="button" accessibilityLabel="Add attachment" onPress={props.onAddAttachment}><Text style={{ color: theme.colors.primary, fontSize: 24 }}>＋</Text></Pressable>}
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
          accessibilityLabel="Send message"
          disabled={!value.trim() || props.isSending}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={() => void send()}
          style={styles.sendButton}
        >
          <Text style={{ color: value.trim() ? theme.colors.primary : theme.colors.mutedText, fontWeight: '700' }}>Send</Text>
        </Pressable>
      </View>}
  </View>
}

function DefaultMessageRow(props: MessageRowContext & Pick<MessageListViewProps, 'renderMedia' | 'renderReadReceipt' | 'onAttachmentPress'>): ReactElement {
  const theme = useConvoKitTheme(); const pending = isConvoKitPendingMessage(props.message)
  return <View style={{ alignItems: props.isCurrentUser ? 'flex-end' : 'flex-start', marginBottom: theme.spacing.md }}>
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
      <Text style={{ color: props.isCurrentUser ? theme.colors.outgoingText : theme.colors.mutedText, opacity: 0.75, fontSize: theme.typography.caption }}>
        {pending ? 'Sending…' : props.message.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </Text>
    </View>
    {props.isCurrentUser && !pending && props.readerIds.size > 0 && <>{props.renderReadReceipt?.(props.message, props.readerIds) ??
      <Text style={{ color: theme.colors.mutedText, fontSize: theme.typography.caption }}>Read by {props.readerIds.size}</Text>}</>}
  </View>
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
  sendButton: { minWidth: 72, minHeight: 48, paddingHorizontal: 12, paddingVertical: 12, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, maxHeight: 120, minHeight: 42, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 9 },
  bubble: { maxWidth: 520, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9, gap: 5 },
  image: { width: 240, height: 180, borderRadius: 10 }, file: { minWidth: 240, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 },
  error: { padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
})
