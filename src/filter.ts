import type { Conversation } from '@convokitapp/react-native'

export interface ConversationFilter {
  query?: string
  archived?: boolean
  participantIds?: ReadonlySet<string>
  predicate?: (conversation: Conversation) => boolean
  comparator?: (left: Conversation, right: Conversation) => number
}

export interface ConversationPageRequest {
  limit: number
  offset: number
  filter: ConversationFilter
}

export type ConversationPageLoader = (request: ConversationPageRequest) => Promise<Conversation[]>

export function filterConversations(
  conversations: readonly Conversation[], filter: ConversationFilter,
): Conversation[] {
  const query = filter.query?.trim().toLocaleLowerCase()
  const result = conversations.filter(conversation => {
    if (query && ![conversation.displayTitle, conversation.title, conversation.description]
      .some(value => value?.toLocaleLowerCase().includes(query))) return false
    if (filter.participantIds?.size && !conversation.participants.some(
      participant => filter.participantIds?.has(participant.appUserId),
    )) return false
    return filter.predicate?.(conversation) ?? true
  })
  return filter.comparator ? result.sort(filter.comparator) : result
}
