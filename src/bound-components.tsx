import { useEffect, useRef, type ReactElement } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import type { ConvoKitClient, Conversation } from '@convokitapp/react-native'
import { DefaultConvoKitUiClient, type ConvoKitUiClient } from './client'
import { ConversationController } from './conversation-controller'
import { ConversationListController } from './conversation-list-controller'
import {
  ConvoKitConversationListView, ConvoKitConversationView,
  type ConversationListViewProps, type MessageListViewProps,
} from './components'
import type { ConversationFilter, ConversationPageLoader } from './filter'
import { useControllerState } from './hooks'

export interface ConvoKitConversationListProps extends Omit<ConversationListViewProps,
  'conversations' | 'onLoadMore' | 'isInitialLoading' | 'isLoadingMore' | 'hasMore' | 'error'> {
  sdk?: ConvoKitClient
  client?: ConvoKitUiClient
  controller?: ConversationListController
  initialFilter?: ConversationFilter
  pageLoader?: ConversationPageLoader
  pageSize?: number
}

export function ConvoKitConversationList(props: ConvoKitConversationListProps): ReactElement {
  const owned = useRef<ConversationListController | null>(null)
  if (!props.controller && !owned.current) {
    const client = props.client ?? (props.sdk ? new DefaultConvoKitUiClient(props.sdk) : null)
    if (!client) throw new Error('Provide sdk, client, or controller')
    owned.current = new ConversationListController({
      client,
      ...(props.initialFilter ? { initialFilter: props.initialFilter } : {}),
      ...(props.pageLoader ? { pageLoader: props.pageLoader } : {}),
      ...(props.pageSize ? { pageSize: props.pageSize } : {}),
    })
  }
  const controller = props.controller ?? owned.current!
  const state = useControllerState(controller)
  useEffect(() => () => { if (owned.current) void owned.current.dispose() }, [])
  return <ConvoKitConversationListView
    {...props}
    conversations={state.conversations}
    isInitialLoading={state.isInitialLoading}
    isLoadingMore={state.isLoadingMore}
    hasMore={state.hasMore}
    error={state.error}
    onRefresh={() => controller.refresh()}
    onLoadMore={() => controller.loadMore()}
  />
}

export interface ConvoKitConversationProps extends Omit<MessageListViewProps,
  'conversation' | 'messages' | 'currentUserId' | 'readAtByUserId' | 'onLoadOlder' |
  'hasOlderMessages' | 'isLoadingOlder' | 'error'> {
  conversationId: string
  sdk?: ConvoKitClient
  client?: ConvoKitUiClient
  controller?: ConversationController
  messagePageSize?: number
  markReadOnLoad?: boolean
  markReadOnReceive?: boolean
  typingTimeoutMs?: number
  onBack?: () => void
  onAddAttachment?: () => void
  onConversationLoaded?: (conversation: Conversation) => void
}

export function ConvoKitConversation(props: ConvoKitConversationProps): ReactElement {
  const owned = useRef<ConversationController | null>(null)
  if (!props.controller && !owned.current) {
    const client = props.client ?? (props.sdk ? new DefaultConvoKitUiClient(props.sdk) : null)
    if (!client) throw new Error('Provide sdk, client, or controller')
    owned.current = new ConversationController({
      conversationId: props.conversationId, client,
      ...(props.messagePageSize ? { messagePageSize: props.messagePageSize } : {}),
      ...(props.markReadOnLoad === undefined ? {} : { markReadOnLoad: props.markReadOnLoad }),
      ...(props.markReadOnReceive === undefined ? {} : { markReadOnReceive: props.markReadOnReceive }),
      ...(props.typingTimeoutMs ? { typingTimeoutMs: props.typingTimeoutMs } : {}),
    })
  }
  const controller = props.controller ?? owned.current!
  const state = useControllerState(controller)
  useEffect(() => () => { if (owned.current) void owned.current.dispose() }, [])
  useEffect(() => { if (state.conversation) props.onConversationLoaded?.(state.conversation) }, [state.conversation, props.onConversationLoaded])
  if (!state.conversation) {
    return <ConvoKitConversationViewPlaceholder loading={state.isInitialLoading} error={state.error} retry={() => controller.loadInitial()} />
  }
  return <ConvoKitConversationView
    {...props}
    conversation={state.conversation}
    messages={state.messages}
    currentUserId={state.currentUserId}
    typingUserIds={state.typingUserIds}
    readAtByUserId={state.readAtByUserId}
    isInitialLoading={state.isInitialLoading}
    isLoadingOlder={state.isLoadingOlder}
    isSending={state.isSending}
    hasOlderMessages={state.hasOlderMessages}
    conversationError={state.error}
    onLoadOlder={() => controller.loadOlderMessages()}
    onRefresh={() => controller.refresh()}
    onSendMessage={async ({ text }) => Boolean(await controller.sendMessage({ text }))}
    onTypingChanged={typing => { void controller.updateTyping(typing) }}
  />
}

function ConvoKitConversationViewPlaceholder(props: { loading: boolean; error: unknown; retry(): void }): ReactElement {
  if (props.loading) return <ActivityIndicator accessibilityLabel="Loading conversation" />
  return <View accessibilityRole="alert"><Text>{props.error instanceof Error ? props.error.message : 'Conversation unavailable'}</Text>
    <Pressable accessibilityRole="button" onPress={props.retry}><Text>Retry</Text></Pressable></View>
}
