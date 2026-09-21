# Changelog

## 0.6.0

- Inbox previews and accurate unread counts. When the adapter exposes
  `listInbox` and no custom `pageLoader` is set, `ConversationListController`
  pages `GET /api/v1/inbox` by cursor instead of `getConversations` by offset.
  `ConversationListState` gains `summaries` (conversation id ->
  `InboxSummary`: `latestMessage`, `unreadCount`, `unreadCountCapped`,
  `readPosition`, `lastReadAt`, `activityAt`), `currentUserId` (the bound user;
  `''` without a session, on the legacy path and after dispose) and
  `isRefreshing`. `conversations`, filters, comparators, custom offset
  `pageLoader`s and the existing renderer signatures are untouched.
- Ordering: rows arrive in the server's activity order (`activityAt` desc, id
  desc). Pages are merged by conversation id, a later entry replaces an earlier
  one, and the activity order is re-applied whenever pages are combined
  (`loadMore` and `refresh`). Setting `filter.comparator` replaces that order.
  `Conversation.updatedAt` is never an ordering input. `mergeInboxEntries` and
  `compareInboxActivity` are exported.
- `refresh()` walks from the head in pages of at most 100 until the loaded
  window is covered and something is visible, then swaps rows, summaries and
  the cursor atomically. It never publishes an empty list with `hasMore` while
  more pages exist. Cursor pages may repeat loaded ids (rooms fall below the
  cursor); only a cursor that did not advance is an error
  (`Inbox pagination did not advance`).
- Realtime: the list subscribes to `onInboxActivity` (message inserts/edits and
  read-position advances) beside `onInboxChanged`. Activity refetches are
  throttled by the new `activityRefreshWindowMs` option (default 500 ms,
  max-wait: the first signal starts the window, later ones ride along; `0`
  refreshes immediately). `inbox_changed`, manual `refresh()` and rejoin stay
  immediate and cancel a pending activity timer.
- Endpoint fallback: a 404 from `listInbox` (route absent on a rolled-back
  backend) marks the inbox unavailable for the store, clears `summaries`,
  warns once and re-runs the same operation through `getConversations` without
  evicting rows. The legacy path is also used for custom `pageLoader`s and for
  adapters without `listInbox`, with `summaries` empty.
- List controller fixes: `refresh()` is single-flight and a refresh requested
  during any load runs afterwards instead of being dropped; 401/403 from either
  endpoint and 404 from the legacy endpoint evict the rows (400 keeps them and
  sets `error`); a session end clears the rows and keeps the store inert until
  the next `loadInitial()`; `loadMore()` requested during a refresh runs after
  it.
- Default rows: the participants/description line becomes a one-line preview
  when a summary has a latest message with a body (`You: ` for the caller's
  own message, `<name>: ` for a listed named sender in rooms with more than two
  participants; media-only messages read `Photo`, the file name or `File`,
  `Location`, `Contact`), the activity time replaces the chevron, and an unread
  badge shows `unreadCount` (`99+` above 99 or when capped) with the accessible
  name `<count> unread` (`99+ unread` when capped) while the visible label is
  hidden from the accessibility tree. The row's own accessible name appends
  `, <count> unread` so screen readers announce it; unread titles use the
  heavier weight. New theme token `colors.badge` (optional; unset means `primary`).
- `ConvoKitConversationListView` accepts `summaries` and `currentUserId`;
  `ConversationRowContext` gains optional `summary` and `currentUserId`;
  `conversationPreview` and `unreadBadge` are exported for custom rows.
  Pull-to-refresh is driven by the pull itself, not by background refreshes.
  The inline error `Retry` requests the next page when `hasMore` and
  `onLoadMore` are set (bypassing the end-reached guard) and refreshes
  otherwise; it renders only when one of those callbacks exists.
- 0.6.0 adapter change (additive): `ConvoKitUiClient` gains optional
  `listInbox({ limit, cursor, archived })` and `onInboxActivity(handler)`;
  `DefaultConvoKitUiClient` implements both. Existing adapters keep compiling
  and stay on the legacy path.
- Requires `@convokitapp/react-native` 0.6.x (peer `>=0.6.0 <0.7.0`) and the
  0.6 backend for previews; against an older backend the list falls back as
  above.

## 0.5.0

- Compute read receipts from the server's monotonic read positions. Controllers
  expose `readPositionByUserId` beside `readAtByUserId`; a participant's
  position decides which messages they have read, and `lastReadAt` remains the
  fallback for legacy rows without one. Positions only move forward, including
  across `refresh()`, and the local user's own read is no longer invented from
  the device clock.
- Acknowledge the newest rendered, confirmed message by id
  (`markConversationRead(id, { throughMessageId })`) instead of "everything on
  the server", so a delayed request cannot mark later messages read. Requests
  coalesce (one in flight, one follow-up resolved at send time) and skip targets
  at or before the last acknowledged one. A room with no confirmed rendered
  message sends nothing.
- Gate acknowledgements on visibility: `ConversationController.setVisible`,
  wired to `AppState` by `useConvoKitConversation`, `ConvoKitConversation` and
  the new `useConvoKitVisibility` hook. Hidden defers the request; returning to
  the foreground re-issues only a deferred one.
- Recover from a refused target: a `MESSAGE_NOT_FOUND` rejection, a deletion or
  a hydration 404 of the in-flight or last acknowledged message marks it
  unacknowledgeable and retries once with the next newest rendered row.
  Membership failures still surface as `error`.
- Only a newly rendered foreign insert triggers `markReadOnReceive`; edits and
  redelivered rows do not. `markReadOnLoad` / `markReadOnReceive` keep their
  semantics, and both `false` still means no read request is ever sent.
- 0.5.0 adapter change: `ConvoKitUiClient.markConversationRead(id, options?)`
  gains the optional `{ throughMessageId }` target (type-compatible with
  existing implementations). Adapters that ignore it acknowledge the newest
  message on the server at request time; adapters must reject an unknown target
  with an error whose `code` is `MESSAGE_NOT_FOUND` for the retry to apply.
- `ConvoKitMessageListView` / `ConvoKitConversationView` accept
  `readPositionByUserId`; `readAtByUserId` still works alone. `resolveReaderIds`
  is exported for custom `readersResolver` implementations. Pending rows never
  reach `readersResolver`.
- Requires `@convokitapp/react-native` 0.5.x. Mixed fleet: precise receipts need
  the sender and the reader on 0.5 with the backend read-position migration;
  0.4 receivers keep timestamp semantics but keep parsing the additive payload.
