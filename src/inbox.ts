import type { Conversation, InboxEntry, InboxSummary, Message } from '@convokitapp/react-native'

export interface InboxRows {
  conversations: Conversation[]
  summaries: ReadonlyMap<string, InboxSummary>
}

/** Inbox order: newest activity first, ties broken by id descending (code-unit compare, matching the
 * server's `activityAt DESC, id DESC`). A row without a summary falls back to its creation time.
 */
export function compareInboxActivity(
  summaries: ReadonlyMap<string, InboxSummary>,
): (left: Conversation, right: Conversation) => number {
  const key = (row: Conversation) => summaries.get(row.id)?.activityAt.getTime() ?? row.createdAt.getTime()
  return (left, right) => key(right) - key(left) || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0)
}

/** Merge inbox pages by conversation id: a later entry replaces an earlier one (a room that moved
 * between requests keeps its newest summary), then rows are re-ordered by activity. Server order is
 * authoritative within one page; this order is applied whenever pages are combined.
 */
export function mergeInboxEntries(
  conversations: readonly Conversation[],
  summaries: ReadonlyMap<string, InboxSummary>,
  entries: readonly InboxEntry[],
): InboxRows {
  const byId = new Map(conversations.map(row => [row.id, row]))
  const merged = new Map(summaries)
  for (const { conversation, ...summary } of entries) {
    byId.set(conversation.id, conversation)
    merged.set(conversation.id, summary)
  }
  return { conversations: [...byId.values()].sort(compareInboxActivity(merged)), summaries: merged }
}

function previewBody(message: Message): string {
  const text = message.text?.trim()
  if (text) return text
  const media = message.media[0]
  if (!media) return ''
  switch (media.type) {
    case 'image': return 'Photo'
    case 'file': return media.name?.trim() || 'File'
    case 'location': return 'Location'
    case 'contact': return 'Contact'
    default: return ''
  }
}

/** The default row's preview line, or null when the row should keep its participants/description line.
 * `You: ` prefixes the caller's own message (DMs included); in rooms with more than two participants a
 * listed sender with a non-blank name is named; departed or unnamed senders get no prefix.
 */
export function conversationPreview(
  conversation: Conversation, summary: InboxSummary, currentUserId?: string,
): string | null {
  const message = summary.latestMessage
  if (!message) return null
  const body = previewBody(message)
  if (!body) return null
  if (currentUserId && message.senderId === currentUserId) return `You: ${body}`
  if (conversation.participants.length > 2) {
    const sender = conversation.participants.find(row => row.appUserId === message.senderId || row.id === message.senderId)
    const name = sender?.name?.trim()
    if (name) return `${name}: ${body}`
  }
  return body
}

/** The unread badge for a summary, or null when nothing is unread. A count (or a capped count) is the
 * numeric badge: the visible label caps at `99+` and the accessible name carries the real count unless the
 * server capped it. A room the caller marked unread with no count (`isUnread` while `unreadCount` is 0
 * and not capped) is a numberless dot: an empty label, the accessible name `Unread` and `dot: true`,
 * never an invented count. A summary built without `isUnread` keeps the numeric rule.
 */
export function unreadBadge(summary: InboxSummary): { label: string; accessibilityLabel: string; dot?: boolean } | null {
  if (summary.unreadCount > 0 || summary.unreadCountCapped) {
    const label = summary.unreadCount <= 99 && !summary.unreadCountCapped ? String(summary.unreadCount) : '99+'
    return { label, accessibilityLabel: summary.unreadCountCapped ? '99+ unread' : `${summary.unreadCount} unread` }
  }
  return summary.isUnread ? { label: '', accessibilityLabel: 'Unread', dot: true } : null
}
