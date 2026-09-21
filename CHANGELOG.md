# Changelog

## 0.8.0

- Edit and delete your own messages. `ConversationController` (and so
  `useConvoKitConversation`) owns edit mode: `ConversationState` gains
  `editingMessage` (the snapshot of the caller's own message being edited; null
  outside edit mode), `canEditMessages` and `canDeleteMessages` (whether the
  adapter implements the 0.8 members), and the controller gains
  `startEditing(messageId)` (a no-op for foreign, pending, removed or unknown
  rows, for a `READ` role when the conversation reports one, and without
  adapter support), `cancelEditing()`, `saveEdit(text)` and
  `deleteMessage(messageId)` (both resolve a boolean; both reject with
  `This ConvoKitUiClient adapter does not implement editMessage/deleteMessage
  (0.8)` on an adapter without the member).
- `saveEdit` sends the trimmed text (empty becomes `null`, which clears the
  caption of a message with attachments; a text-only message is never saved
  empty, no request) with the snapshot's `revision`, captured by
  `startEditing`, never the live row's. A stale revision (409
  `REVISION_CONFLICT`) reloads the row once through `getMessage`: the row shows
  the new content, the snapshot is refreshed so the next save carries the fresh
  revision, `error` carries the conflict and the composer keeps the edited
  text. The same conflict state is entered without a request whenever a row for
  the edited id with a higher revision reaches the store (an UPDATE image, a
  hydration, a reconcile), except while that row's own save is in flight: its
  images (the edit's own UPDATE image often beats the response) merge and wait
  for the response, a success ends edit mode, and any other failure re-checks
  the row so a genuinely newer one is a conflict after all. A save, or the
  conflict reload, that answers 404 with code `MESSAGE_NOT_FOUND` removes the
  row and leaves edit mode; any other
  failure (a 0.7 backend's uncoded 404 on the `/own` routes, 403, network)
  sets `error` and keeps the row and the session. `deleteMessage` removes the
  row only once the adapter resolves or answers `MESSAGE_NOT_FOUND`
  (tombstone first, so late edit responses, row images and hydrations for the
  id are dropped, the read acknowledgement re-targets, and edit mode is left
  when it was that row); other failures keep the row and set `error`. A remote
  `message_deleted` for the edited row, or a `refresh()` whose page no longer
  carries it, leaves edit mode.
- Row precedence: when both rows carry a usable `revision` and they differ, the
  higher one wins and a lower one never overwrites (a late edit response never
  rewinds a newer live row, and a `refresh()` page fetched before an edit never
  rewinds the edited row); equal revisions, pending rows (`revision: 0`) and
  rows from a 0.7 backend keep the `updatedAt ?? createdAt` rule with its
  existing tie-breaks.
- Default rows: an eligible row (the view was given `onEditMessage` /
  `onDeleteMessage`, the row is the caller's own and confirmed, the caller's
  role is not `READ`) is wrapped in a long-pressable with the `Message actions`
  accessibility action and hint; a long press opens an `Alert` sheet with
  `Edit message`, `Delete message` and `Cancel`, and deleting confirms with
  `Delete this message?` (`Delete` / `Cancel`; dismissing declines).
  `confirmDelete(message)` replaces the dialog. Edited rows (`revision > 0`)
  show `Edited` (accessible name `Edited`) beside the time. Rows that are not
  eligible, and every row without the callbacks, render byte-identically to
  0.7.
- Default composer edit mode: while `editingMessage` is set the unsent draft is
  stashed and the field is prefilled with the message text without a typing
  update, a polite live-region banner reads `Editing message` with the original
  text (or the attachment word for a caption-less media message) beside
  `Cancel` (accessible name `Cancel editing`), and the primary action becomes
  `Save` (accessible name `Save message`; `Send message` otherwise). Save is
  enabled while the trimmed field is non-empty or the edited message has
  attachments. Cancel and a successful save restore the stash and report
  typing for it (`false` for an empty stash, `true` otherwise); a failed save
  keeps the text and edit mode; when the host leaves edit mode externally the
  field keeps user-changed text and restores the stash only when it is empty or
  unchanged. `renderComposer` receives the additive `editing` (the message) and
  `cancelEdit` while editing; its `send()` saves then, so custom composers need
  no branching. The input type is exported as `ComposerContext`.
- Controlled views: `ConvoKitMessageListView` gains `onEditMessage`,
  `onDeleteMessage` (`false` reports that nothing was deleted),
  `canEditMessage` (replaces the own/role rule for both actions; pending rows
  stay ineligible) and `confirmDelete`; `ConvoKitConversationView` adds
  `editingMessage`, `onSaveEdit(message, text)` (`false` keeps edit mode and
  the text, like `onSendMessage`) and `onCancelEdit`. Without the callbacks the
  markup is byte-identical to 0.7. `MessageRowContext` gains `isEdited`,
  `canEdit`, `canDelete` and, only while allowed, `edit()` and `remove()`
  (confirms, then calls `onDeleteMessage`; resolves whether it was deleted).
  `ConvoKitConversation` wires the controller (`editingMessage`,
  `startEditing`, `saveEdit`, `cancelEditing`, `deleteMessage`) only when the
  adapter supports the members and passes `confirmDelete` and `canEditMessage`
  through; `onEditMessage` / `onDeleteMessage` are not props of the bound
  component.
- 0.8.0 adapter change (additive): `ConvoKitUiClient` gains optional
  `editMessage(messageId, { text, revision })` (both keys always sent; a stale
  revision must reject with `code` `REVISION_CONFLICT`, a gone message with
  `code` `MESSAGE_NOT_FOUND`) and `deleteMessage(messageId)`;
  `DefaultConvoKitUiClient` implements both. Adapters without them keep
  compiling: no action renders and the two controller methods reject.
- `Message.revision` is required by the 0.8 core, so consumer-built `Message`
  literals (controlled views, fixtures) gain `revision: 0`. The library derives
  the edited state locally (`revision > 0`).
- Requires `@convokitapp/react-native` 0.8.x (peer `>=0.8.0 <0.9.0`) and the
  0.8 backend for the author endpoints. Mixed fleet: a 0.7 view ignores
  `revision` and shows no actions; a 0.8 view against a 0.7 backend renders the
  actions but every save and delete fails with an uncoded 404 that keeps the
  row and the draft.

## 0.7.0

- Private "mark unread". `InboxSummary` (and so `summaries`) carries the 0.7
  core's `isUnread` (`unreadCount > 0 || unreadCountCapped || unreadMarkedAt !==
  null`), `unreadMarkedAt` and `privateStateVersion`; the core makes them
  required, so consumer-built summary literals (controlled lists, fixtures) gain
  three members. Summaries flow through `mergeInboxEntries` unchanged (later
  entry wins).
- Default rows: a row is unread while `isUnread`, the count is above zero or
  the count is capped (heavier title). The numeric badge is unchanged for a
  count (`99+` when capped, marker or not); a marked room with a count of 0 and
  not capped renders a numberless 8-pt dot in the badge colour with the
  accessible name `Unread`, and the row's own name appends `, Unread`. Never
  `0 unread`. `unreadBadge` returns the additive
  `{ label: '', accessibilityLabel: 'Unread', dot: true }` for that case; a
  summary without `isUnread` keeps the numeric rule.
- `ConversationListController` gains `markUnread(conversationId)` and
  `clearUnread(conversationId, { ifVersion? })` (resolves the response's
  `cleared`). On any answer the response's `{ unreadMarkedAt,
  privateStateVersion }` is applied to the room's current summary as one unit
  and `isUnread` recomputed, only when the response is newer than the stored
  version (equal is a no-op, lower is ignored), so a delayed answer never
  resurrects a marker a newer action removed; an answer that lands after the
  store was disposed, retired or reloaded (possibly for another user) is
  dropped. A request failure sets `error`
  without evicting rows (`clearUnread` then resolves `false`); an adapter
  without the members makes both reject. No default row action; other devices
  refetch through `onInboxActivity`, which now also fires for marker changes.
- `ConversationController` captures `conversation.membership.privateStateVersion`
  once per open (on `loadInitial`, or on the `refresh()` after a transient
  first-load failure; never from a later refresh) and sends it as
  `privateStateVersion` with every targeted acknowledgement of that open;
  without a `membership` (0.6 backend) the body is byte-identical to 0.6. An
  opened room that was marked and renders nothing calls
  `clearConversationUnread(id, { ifVersion: captured })` once per open under
  the load acknowledgement's gating (`markReadOnLoad`, visibility, explicit
  `markRead()`), never once a row was rendered; `cleared: false` is not an
  error. The controller still never acknowledges without a target.
- 0.7.0 adapter change (additive): `ConvoKitUiClient` gains optional
  `markConversationUnread(id)` and `clearConversationUnread(id, { ifVersion? })`;
  `DefaultConvoKitUiClient` implements both. `markConversationRead` options may
  now carry `privateStateVersion`; adapters must forward the options unchanged
  or acknowledgements never clear the marker. Adapters without the new members
  keep compiling: the list methods reject and an empty marked room keeps its
  marker.
- Requires `@convokitapp/react-native` 0.7.x (peer `>=0.7.0 <0.8.0`) and the
  0.7 backend for the marker. Mixed fleet: a 0.6 list ignores `isUnread`; a
  0.7 list against a 0.6 backend derives `isUnread` from the count and the
  `/unread` calls fail with status 404.

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
