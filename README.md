# `@convokitapp/react-native-ui`

Controlled and SDK-backed ConvoKit chat components for bare React Native and
Expo. The package has no navigation, picker, filesystem, or Expo dependency.

```tsx
<ConvoKitConversationList
  sdk={client}
  onConversationSelected={setSelectedConversation}
/>

<ConvoKitConversation
  sdk={client}
  conversationId={selectedConversation.id}
  onBack={() => setSelectedConversation(null)}
/>
```

Use the `*View` components when application state is owned outside ConvoKit.
All major rows and states accept render callbacks, and `ConvoKitUiProvider`
provides platform-neutral theme tokens.

Pagination, optimistic sends, realtime reconciliation, deletion tombstones,
edit mode for the caller's own messages, quoted replies and jump-to-message
windows, typing indicators, read receipts, and
media rendering live in shared controllers. Navigation, safe areas, pickers, downloads, and attachment
opening stay behind application callbacks. This package deliberately imports
neither Expo modules nor app-specific native libraries, keeping a future
`react-native-web` target open.

Optimistic rows display `Sending…` until acknowledgement. A confirmed message
shows its server timestamp, and `Read by N` once other participants have read
it. ConvoKit does not report recipient delivery, so the default rows never
claim a delivered state; replace `renderReadReceipt` for custom wording.

## Read receipts

Receipts follow the server's read positions. `ConversationState` carries
`readPositionByUserId` (each participant's monotonic `ReadPosition`, seeded
from the conversation and advanced by `read` events) beside `readAtByUserId`
(the acknowledgement time). A user has read a message when their position is at
or after it in `(createdAt, id)` order; a legacy participant without a position
falls back to `lastReadAt >= createdAt`. Positions never move backward, and the
local user's own read is never invented on the device. The controlled views take
the same two maps; `readAtByUserId` alone still works, and `resolveReaderIds`
implements the rule for custom `readersResolver` callbacks.

Automatic acknowledgement keeps `markReadOnLoad` and `markReadOnReceive`
(both default to `true`; both `false` means no read request is ever sent). The
request names the newest rendered, confirmed message (`throughMessageId`), so a
request that arrives late cannot mark later messages read. Only a newly rendered
foreign message is a receive trigger; media-only rows count once they are
hydrated, pending rows are never targeted, and a room without a confirmed
rendered message sends nothing. Requests coalesce: one in flight,
one follow-up resolved at send time, none when the target is at or before the
last acknowledged one. Acknowledgements are gated on visibility:
`useConvoKitConversation` and `ConvoKitConversation` report `AppState` through
`controller.setVisible`, a hidden app defers the request, and returning to the
foreground re-issues only a deferred one. Apps that own a controller can reuse
`useConvoKitVisibility(controller)`. If the server no longer knows the target
(`MESSAGE_NOT_FOUND`), or the in-flight or last acknowledged target is deleted,
the controller retries once with the next newest rendered row. A deletion
re-issues only where `markReadOnReceive` is enabled: a room that opted out of
receive acknowledgements never sends one because a deletion arrived (an
explicit `markRead()` still acknowledges the newest rendered row). Membership
failures still surface as `error`.

Custom `ConvoKitUiClient` adapters receive the target as
`markConversationRead(id, { throughMessageId })`. Adapters that ignore it
acknowledge the newest message on the server at request time, and adapters
should reject an unknown target with an error whose `code` is
`MESSAGE_NOT_FOUND` so the retry applies.

Mixed fleet: precise receipts need the sender and the reader on 0.5 with the
backend read-position migration; 0.4 receivers keep timestamp semantics but
keep parsing the additive payload.

## Inbox previews and unread counts

`ConvoKitConversationList` and `useConvoKitConversationList` page the inbox
(`listInbox`, cursor-based) whenever the adapter exposes it and no custom
`pageLoader` is set. `ConversationListState` then carries `summaries`, a map
from conversation id to `InboxSummary` (`latestMessage`, `unreadCount`,
`unreadCountCapped`, `readPosition`, `lastReadAt`, `activityAt`, and since
0.7 `isUnread`, `unreadMarkedAt`, `privateStateVersion`), and
`currentUserId`, the bound user (`''` without a session, on the legacy path
and after `dispose`). `isRefreshing` reports a background walk.
`conversations`, filters, comparators, custom offset `pageLoader`s and the
existing renderer signatures are unchanged.

Ordering follows the server: `activityAt` descending, then id descending.
Pages are merged by conversation id, a later entry replaces an earlier one (a
room that moved keeps its newest summary), and the activity order is re-applied
whenever pages are combined, on `loadMore` and on `refresh`. Setting
`filter.comparator` replaces that order; `Conversation.updatedAt` is never an
ordering input. `refresh()` walks from the head in pages of at most 100 until
the loaded window is covered and something is visible, then swaps rows,
summaries and the cursor atomically, so it never publishes an empty list with
`hasMore` while more pages exist. Cursor pages may legitimately repeat loaded
ids; only a cursor that does not advance is an error. `mergeInboxEntries` and
`compareInboxActivity` implement the rule for custom stores.

Live updates: the list subscribes to `onInboxChanged` (structural changes and
deletions, refetched immediately) and `onInboxActivity` (message inserts and
edits, read-position advances). Activity is throttled by
`activityRefreshWindowMs` (default `500`): the first signal starts the window,
later signals ride along, and one refresh runs when it fires; `0` refreshes
immediately. `inbox_changed`, a manual `refresh()` and a rejoin stay immediate
and drop a pending activity timer. Room controllers subscribe to
`onInboxChanged` only (never `onInboxActivity`) and reconcile the open room on
every signal, exactly as on a rejoin, so a title or membership change, or a
deletion whose `message_deleted` was missed, reaches the room without a
foreground return. A signal that lands during the initial load, a reconcile
or a history page queues one `refresh()` that runs afterwards (the SDK also
delivers `inbox_changed` on every join, so an open room reconciles once right
after loading), and a burst coalesces into that one refresh. The subscription
is released with the room's other subscriptions on dispose and on the next
`loadInitial()`.

Default rows replace the participants/description line with a one-line preview
when the summary has a latest message with a body: `You: hi` for the caller's
own message (DMs included), `Ana: hi` for a listed, named sender in rooms with
more than two participants, plain `hi` otherwise (DMs, departed or unnamed
senders). Media-only messages read `Photo`, the file name or `File`,
`Location` and `Contact`; a room without a body keeps today's line. The
activity time is shown in the device zone. An unread badge renders while
`unreadCount > 0` or the count is capped: the visible label is the count, or
`99+` above 99 and when the server capped it at 1,000; the accessible name is
`<count> unread` (`99+ unread` when capped) and the visible label is hidden
from the accessibility tree. The row's own accessible name appends
`, <count> unread`. Unread titles use the heavier weight. The badge colour is
the new theme token `colors.badge` (unset means `primary`). A room the caller
marked unread without a count renders a numberless dot instead; see
[Mark unread](#mark-unread).

Custom rows receive the additive `summary` and `currentUserId` on
`ConversationRowContext`; `conversationPreview(conversation, summary,
currentUserId)` and `unreadBadge(summary)` return the default strings. The
controlled `ConvoKitConversationListView` accepts `summaries` and
`currentUserId` (absent means today's rows and no `You:` prefix).
Pull-to-refresh is driven by the pull itself, never by background refreshes.
The inline error `Retry` requests the next page when `hasMore` and
`onLoadMore` are set, otherwise it calls `onRefresh`, and renders only when
one of those exists.

Custom `ConvoKitUiClient` adapters may implement the optional
`listInbox({ limit, cursor, archived })` and `onInboxActivity(handler)`;
`DefaultConvoKitUiClient` does. An adapter without `listInbox`, or a custom
`pageLoader`, uses `getConversations` with `summaries` empty. A 404 from
`listInbox` (the route is absent on a rolled-back backend) marks the inbox
unavailable for that store, clears `summaries`, warns once and re-runs the
same operation through `getConversations` without evicting rows; 401/403 from
either endpoint and 404 from the legacy endpoint evict the rows, 400 keeps
them and sets `error`.

## Mark unread

Since 0.7 a user can flag a room to come back to. The marker is private: other
members, webhooks and `read` events never see it, and `unreadCount` is not
changed. It needs the 0.7 backend and `@convokitapp/react-native` 0.7.

`InboxSummary` carries `isUnread` (`unreadCount > 0 || unreadCountCapped ||
unreadMarkedAt !== null`), `unreadMarkedAt` (`null` while nothing is marked)
and `privateStateVersion`. A row is unread while `isUnread`, the count is above
zero or the count is capped, and uses the heavier title weight. `unreadBadge`
keeps returning the numeric badge for a count (`99+` when capped, marker or
not); when `isUnread` is true while the count is 0 and not capped it returns
`{ label: '', accessibilityLabel: 'Unread', dot: true }` and the default row
renders an 8-pt circle in the badge colour with the accessible name `Unread`,
never an invented count. The row's own accessible name becomes
`Open <title>, Unread`. A summary built without `isUnread` keeps the numeric
rule, so controlled lists with older fixtures render as before.

`ConversationListController` (and so `useConvoKitConversationList`) exposes
`markUnread(conversationId)` and `clearUnread(conversationId, { ifVersion? })`.
They call the adapter's `markConversationUnread` / `clearConversationUnread`;
on any answer the response's `{ unreadMarkedAt, privateStateVersion }` is
applied to the room's current summary as one unit and `isUnread` is
recomputed, but only when the response is newer than the stored version, so a
delayed answer never resurrects a marker a newer action removed; an answer
that lands after the store was disposed, retired or reloaded (possibly for
another user) is dropped. `clearUnread`
resolves the response's `cleared`: whether this request removed the marker,
not whether the room is read. A stale `ifVersion` or an unmarked room resolves
`false` with the current state applied. A request failure sets `error`, keeps
the row and rejects (catch the promise), so only a `cleared:
false` answer resolves `false`. An adapter without the two members makes both
methods reject, and so does a controller that is not active: disposed, retired
after the session ended, bound to a session the shared client has since
replaced, or never loaded. Both reject with `ConversationListController is not
active` before any request goes out, because a private marker must never be
written under another user's login; `error` is untouched (there is no live
snapshot to report into). Other devices learn of a change through
`onInboxActivity`, which the list already refetches from. There is no default
row action: wire one through a custom `renderItem` (a long-press, a menu) that
calls the controller returned by `useConvoKitConversationList`, or pass your
own `controller` to `ConvoKitConversationList`. On the legacy path (custom
`pageLoader`, adapter without `listInbox`) the methods still call the adapter
but there is no summary to patch.

Capture at open: `ConversationController` reads
`conversation.membership.privateStateVersion` (the caller's own row, returned
by `getConversation` from a 0.7 backend) the first time the open's
conversation loads (on `loadInitial`, or on the `refresh()` that follows a
transient first-load failure) and sends it as `privateStateVersion` with every
targeted acknowledgement of that open. The backend clears the marker only when
that version is still current, so a mark issued after the room opened survives
the acknowledgements that open keeps sending; a later `refresh()` (including
the one `useConvoKitConversation` triggers on foreground) never re-captures,
and `loadInitial()` or a new controller captures again. Against a 0.6 backend
(no `membership`) acknowledgements carry no version and are byte-identical to
0.6. An opened room that was marked and renders nothing has no target to
acknowledge, so the controller calls
`clearConversationUnread(id, { ifVersion: captured })` once per open instead:
under the same gating as the load acknowledgement (`markReadOnLoad`, deferred
while hidden and issued on visibility, also by an explicit `markRead()`), and
never once a row was rendered, because the targeted acknowledgement clears
then. `cleared: false` is not an error; a failed request surfaces as `error`.
The controller still never sends an acknowledgement without a target.

0.7.0 adapter change (additive): `ConvoKitUiClient` gains the optional
`markConversationUnread(id)` and `clearConversationUnread(id, { ifVersion? })`;
`DefaultConvoKitUiClient` implements both. Adapters without them keep
compiling: the list methods reject and an empty marked room keeps its marker.
`markConversationRead(id, options)` is unchanged, but `options` may now carry
`privateStateVersion`: forward the options unchanged, since an adapter that
drops them acknowledges without a version and never clears the marker.

Mixed fleet: a 0.6 list ignores `isUnread` and shows no dot; a 0.7 list against
a 0.6 backend derives `isUnread` from the count with no marker, and the
`/unread` calls fail with status 404.

## Edit and delete your own messages

Since 0.8 a user can edit the text of their own messages and delete them. It
needs the 0.8 backend and `@convokitapp/react-native` 0.8. Rows carry the
core's `Message.revision` (0 when sent, +1 on every edit); `revision > 0` is
the only edited signal and the default rows show `Edited` beside the time.
Consumer-built `Message` literals gain `revision: 0`.

Controller members. `ConversationController` (and `useConvoKitConversation`)
owns edit mode. `ConversationState` carries `editingMessage`, the snapshot of
the caller's message being edited (null outside edit mode), and
`canEditMessages` / `canDeleteMessages`, whether the adapter implements the
0.8 members. `startEditing(messageId)` enters edit mode on one of the caller's
own confirmed rows and is a no-op for foreign, pending, removed or unknown
rows, for a `READ` role when the conversation reports one (the self-only
`membership`, else the caller's `participants` entry) and without adapter
support; `cancelEditing()` leaves it. `saveEdit(text)` trims the text (empty
becomes `null`, which clears the caption of a message with attachments; a
text-only message is never saved empty and sends nothing) and calls the
adapter with the snapshot's `revision`, captured when editing began, never the
live row's. Success merges the response under the deletion and precedence
guards, leaves edit mode and resolves `true`. A stale revision (409
`REVISION_CONFLICT`) reloads the row once: the row shows the other content,
the snapshot is refreshed so the next save carries the fresh revision,
`error` carries the conflict and the composer keeps the edited text. The same
conflict state is entered without a request whenever a row for the edited id
with a higher revision reaches the store (an UPDATE image, a hydration, a
reconcile), except while that row's own save is in flight: its images merge
and wait for the response (a success ends edit mode; any other failure
re-checks the row). A save or reload that answers 404 with code `MESSAGE_NOT_FOUND`
removes the row and leaves edit mode; any other failure (403, network, a 0.7
backend's uncoded 404) sets `error` and keeps the row and the session; every
failure resolves `false`. `deleteMessage(messageId)` removes the row only once
the adapter resolves or answers `MESSAGE_NOT_FOUND` (tombstone first, so late
edit responses, row images and hydrations for the id are dropped and the read
acknowledgement re-targets), leaves edit mode when it was that row and
resolves `true`; other failures keep the row, set `error` and resolve
`false`. A remote `message_deleted` for the edited row, or a `refresh()` whose
page no longer carries it, leaves edit mode.

Deletion safety across a reconcile: `refresh()` (a rejoin, an `inbox_changed`
signal, the foreground return) tombstones every confirmed row it knew when the
reconcile was requested that the refetched range no longer carries, exactly as
a `message_deleted` would, so a deletion missed while offline cannot be
resurrected by a late edit or send response, a hydration or a row image, and
the read acknowledgement re-targets as for any deletion. The reconciled window
is the rendered rows up to the server's page cap of 100. A full page
reconciles from its oldest row on: rows older than that window are dropped
from view, never tombstoned, and `hasOlderMessages` turns true so the next
`loadOlderMessages()` brings them back. Tombstones last until the next
`loadInitial()`.

Row precedence: when two rows for one id both carry a usable `revision` and
they differ, the higher one wins and a lower one never overwrites, so a late
edit response, or a `refresh()` page fetched before an edit, never rewinds a
newer live row; equal revisions, pending rows
and rows from a 0.7 backend keep the `updatedAt ?? createdAt` rule.

Default rows. A row is eligible when the view was given `onEditMessage` /
`onDeleteMessage`, the row is the caller's own and confirmed, and the caller's
role is not `READ`. An eligible row is wrapped in a long-pressable with the
`Message actions` accessibility action (and hint); a long press opens an
`Alert` sheet with `Edit message`, `Delete message` and `Cancel`, and deleting
confirms with `Delete this message?` (`Delete` / `Cancel`; dismissing
declines). Pass `confirmDelete(message)` (resolving a boolean) to replace the
dialog, and `canEditMessage(message)` to replace the own/role rule for both
actions (pending rows stay ineligible). Rows that are not eligible, and every
row without the callbacks, render exactly as in 0.7.

Default composer. While `editingMessage` is set the composer is in edit mode:
the unsent draft is stashed and the field is prefilled with the message text
without a typing update, a banner (a polite live region) reads
`Editing message` with the original text beside `Cancel` (accessible name
`Cancel editing`), and the primary action reads `Save` with the accessible
name `Save message` (`Send message` otherwise). Save is enabled while the
trimmed field is non-empty or the edited message has attachments, so a caption
can be cleared; author edits change text only, so the `Add attachment`
control is hidden while editing. Cancel and a successful save restore the
stash and report typing for it; a failed save keeps the text and edit mode;
when the host leaves edit mode externally (the row was removed) the field
keeps user-changed text and restores the stash only when it is empty or
unchanged. Custom composers receive the additive `editing` (the message) and
`cancelEdit` on the `renderComposer` input (`ComposerContext`) while editing;
`send()` saves then, so no branching is needed.

Controlled views. `ConvoKitMessageListView` accepts `onEditMessage(message)`,
`onDeleteMessage(message)` (`false` reports that nothing was deleted),
`canEditMessage` and `confirmDelete`; `ConvoKitConversationView` adds
`editingMessage`, `onSaveEdit(message, text)` (`false` keeps edit mode and the
text, like `onSendMessage`) and `onCancelEdit`. Without the callbacks nothing
new renders. Custom rows receive `isEdited`, `canEdit`, `canDelete` and, only
while allowed, `edit()` and `remove()` on `MessageRowContext`. `remove()` asks
`confirmDelete` when the view was given one and otherwise calls
`onDeleteMessage` at once, resolving whether the row was deleted:
confirmation UI is the custom row's own. Only the default row shows
the built-in `Delete this message?` dialog when no `confirmDelete` is set.
The bound `ConvoKitConversation` wires the controller (`editingMessage`,
`startEditing`, `saveEdit`, `cancelEditing`, `deleteMessage`) only when the
adapter supports the members and passes `confirmDelete` and `canEditMessage`
through.

0.8.0 adapter change (additive): `ConvoKitUiClient` gains the optional
`editMessage(messageId, { text, revision })` (both keys always sent; a stale
revision must reject with an error whose `code` is `REVISION_CONFLICT`, a
message the server no longer knows with `MESSAGE_NOT_FOUND`) and
`deleteMessage(messageId)`; `DefaultConvoKitUiClient` implements both.
Adapters without them keep compiling: no action renders and the two controller
methods reject.

Attachments are kept as they are by an edit and are not retracted by a delete
for members who already received them. Mixed fleet: a 0.7 view ignores
`revision` and shows no actions; a 0.8 view against a 0.7 backend renders the
actions but every save and delete fails with an uncoded 404 that keeps the
row and the draft.

## Quoted replies and jump to message

Since 0.9 a message can quote another message in the same room, and the reader
can jump to the quoted one even when it is far outside the loaded window. It
needs the 0.9 backend and `@convokitapp/react-native` 0.9. Rows carry the
core's `Message.replyToMessageId` (absent when the row is not a reply); the
reference is write-once, so an edit never changes it and it survives the
deletion of the message it points at. Consumer-built `Message` literals may
omit the key.

Controller members. `ConversationState` gains `replyTarget` (the message the
next send quotes, null outside reply mode), `replyPreviews` (quoted parents by
message id), `highlightedMessageId`, `windowMode` (`live` or `jumped`),
`hasNewerMessages`, `isLoadingNewer`, and `canJumpToMessages` /
`canResolveReplyPreviews` (whether the adapter implements the 0.9 members).
`startReply(messageId)` quotes one of the room's rendered messages — any
member's row, not only the caller's own — and is a no-op for pending, removed
or unknown rows and for a `READ` role when the conversation reports one;
`cancelReply()` drops it. The next `sendMessage()` carries the target, stamps
it on the optimistic row so the quoted block renders before acknowledgement,
and clears `replyTarget` on success. Entering edit mode clears the reply
target and starting a reply leaves edit mode: the composer has one modal
state. Deleting the target row clears it too.

Preview resolution is batched, never one request per row. After every page
load, reconcile and burst of live inserts the controller issues **one**
`getReplyPreviews` call for the distinct `replyToMessageId` values the
rendered rows reference; the SDK chunks at 50 per request. A parent that is
itself in the loaded window is derived locally (text cut at 500 characters
with `textTruncated` set) and costs nothing. `replyPreviews` has three states
per id: a `ReplyPreview`, the terminal `'unavailable'`, and **no entry at
all**, which means "not resolved yet" — render the reference without its text,
never the unavailable copy. An id missing from a batch that *resolved* is the
only deletion signal and becomes `'unavailable'` for good; a batch that
*rejects* writes no entry for any of its ids, surfaces through `error` and is
retried on the next trigger. A cached entry is invalidated by a
`message_deleted` (or a delete response) for that id, by an edit of that row,
and by a reconnect, which marks every non-terminal entry stale. Entries no
rendered row references are dropped, so the map stays bounded by the window.

Jumping. `jumpToMessage(messageId)` highlights a row that is already in the
window without a request. Otherwise one `getMessageContext` centred on the id
**replaces** the window, `windowMode` becomes `jumped` and `hasOlderMessages`
/ `hasNewerMessages` come from the response's cursors. A jump is a window
operation, never a re-open: the acknowledgement floor, the tombstones, the
private state captured when the room opened, the edit session and the reply
target all survive it, and the initial-load path never runs. A coded 404
`MESSAGE_NOT_FOUND` — the guaranteed answer once the quoted message is
deleted — marks that preview `'unavailable'` instead of surfacing an error and
leaves the window untouched; any other failure sets `error` and also leaves it
untouched. `jumpToMessage` is a no-op while a send is in flight, so a
replacement can never strand a pending row.

While jumped: both ends page through `getMessageContext` and the stored
cursors (`loadOlderMessages()` as usual, `loadNewerMessages()` for the newer
end), realtime inserts are **recorded but not rendered**, and no read is
acknowledged (the newest rendered row is not the room's newest). Edits,
revisions and tombstones for rows inside the window still apply. A queued
reconcile does not walk the history: it re-reads the jumped window with one
bounded, centred request anchored at the jump target (or at the window's
midpoint once the window has been paged), tombstones only inside the range the
response returned, and leaves the owed tail reconcile owed so it runs on the
return to live.

`returnToLatest()` is the only way back. It sets `windowMode = 'live'` before
issuing the newest-page request — never after the response — so inserts
arriving during it merge under the usual precedence, and the rows recorded
while jumped join the rendered set, and are acknowledged, at that moment. A
newer page that reports no newer cursor does **not** flip the window in place:
that answer was only true at the server's query time, so `returnToLatest()`
runs instead. If the reload fails the store stays `jumped` with the window
intact, keeps the affordance and surfaces the error; it never lands in `live`
on an unreloaded window. `sendMessage()` awaits `returnToLatest()` first when
the window is jumped and does not send if it fails, leaving `isSending` false
and the draft and the reply target untouched.

Default rows. A row is replyable when the view was given `onReplyToMessage`,
the row is confirmed and the caller's role is not `READ` — any member may
quote any message, so unlike editing this is not limited to the caller's own
rows and the `canEditMessage` override is deliberately not consulted. `Reply`
joins the long-press `Alert` sheet ahead of `Edit message` and
`Delete message`; a row whose only would-be action is unavailable is not
long-pressable at all, so the sheet never opens on `Cancel` alone. A row that
carries `replyToMessageId` shows a quoted block above its text with the
parent's author and text (or its attachment count), `Original message
unavailable` once the parent is gone, or the reference alone while it is not
yet resolved. The block is a button when the view was given
`onJumpToMessage`, with the accessible name `Quoted message from <author>`,
`Original message unavailable` or `Quoted message`; it stays activatable while
the parent is gone. The jumped-to row is tinted with `colors.highlight` (the
themed accent at low opacity when the token is unset, exactly as `colors.badge`
falls back) for about two seconds, and the move is announced through
`AccessibilityInfo`; a drag clears the highlight early.

Default composer. While `replyTarget` is set a cancellable strip above the
input (a polite live region) reads `Replying to <name>` with the quoted text
beside `Cancel` (accessible name `Cancel reply`). Sending clears it,
cancelling clears it, and the primary action stays `Send message`: the quote
rides on the store's send, not on a new callback. Custom composers receive the
additive `replying` (the message) and `cancelReply` on the `renderComposer`
input (`ComposerContext`), flat, as `editing` / `cancelEdit` are.

Controlled views. `ConvoKitMessageListView` accepts `onReplyToMessage`,
`replyPreviewByMessageId` (a `ReadonlyMap<string, ReplyPreview | 'unavailable'>`,
the `readAtByUserId` idiom), `onJumpToMessage(messageId)`,
`highlightedMessageId`, `hasNewerMessages`, `isLoadingNewer`, `onLoadNewer`
and `onHighlightDismissed`; `ConvoKitConversationView` adds `replyTarget`,
`onCancelReply` and `onReturnToLatest`, and renders the `Jump to latest`
control (accessible name `Jump to latest messages`) exactly when
`onReturnToLatest` is given. The newer-edge pagination trigger is the list's
start edge — the opposite one from `onLoadOlder` — and only fires while
`hasNewerMessages` is true, which only a jumped window reports. Without the
new callbacks nothing new renders and the markup is the 0.8 markup. Custom
rows receive `canReply` and, only where they apply, `reply()`, `replyPreview`
and `jumpToReplyTarget()` on `MessageRowContext`. The bound
`ConvoKitConversation` wires all of it from the controller, passing
`onJumpToMessage` only while `canJumpToMessages` and `onReturnToLatest` only
while the window is jumped, and takes `replyPreviewWindowMs` (the live-insert
batching window, default 250) and `highlightDurationMs` (default 2000).

Scrolling to a row uses `scrollToIndex` against the rendered list, with
`onScrollToIndexFailed` nudging to an estimated offset and re-attempting at
most three times — rows are variable height, so there is no `getItemLayout`
and a target outside the render window cannot be measured up front.
`MessageRowContext.chronologicalIndex` is unchanged: with the default
orientation it has always been the rendered (visual) position, and 0.9 does
not move it.

0.9.0 adapter change (additive): `ConvoKitUiClient` gains the optional
`getReplyPreviews(conversationId, messageIds)` and
`getMessageContext(conversationId, { messageId?, olderCursor?, newerCursor?,
limit? })`, and `sendMessage`'s input gains the optional `replyToMessageId`;
`DefaultConvoKitUiClient` implements all three. Adapters without the two new
members keep compiling, and a 0.8 adapter still satisfies the widened
`sendMessage`: `canJumpToMessages` / `canResolveReplyPreviews` are then false,
no jump affordance renders and quoted blocks show the reference without text.

Mixed fleet. Against a 0.8 backend both new routes answer Express's unmatched
route with an **uncoded** 404, which is not "message gone": the preview batch
is treated as unresolved (never `'unavailable'`), a jump leaves the window
untouched, the failure surfaces once, and after the first such rejection the
corresponding capability flag turns false for the life of the controller so
the affordances disappear instead of failing repeatedly. A coded
`MESSAGE_NOT_FOUND` never trips that — it is a real missing target. Sending a
quote to a 0.8 backend is not rejected: the backend ignores the unknown body
key, so the message is sent without its reference and renders with no quoted
block. A 0.8 view against the 0.9 backend ignores `replyToMessageId` entirely.

## Controlled components

Use `ConvoKitConversationListView`, `ConvoKitConversationView` and
`ConvoKitMessageListView` when the application owns state.
`useConvoKitConversationList` and `useConvoKitConversation` return the same
controllers the bound components use, without forcing a state library. Pass
`summaries` and `currentUserId` from the list state to
`ConvoKitConversationListView` for previews and badges (both optional), and
`readPositionByUserId` (plus `readAtByUserId` for users without a position)
to the conversation views for receipts. `useConvoKitConversation` reports
`AppState` itself; when you construct a `ConversationController` yourself,
call `setVisible(false)` while the room is not on screen (or reuse
`useConvoKitVisibility(controller)`) so acknowledgements wait until it is.
Edit mode is a pure function of `editingMessage` plus the callbacks: pass the
controller's `editingMessage`, `startEditing`, `saveEdit`, `cancelEditing` and
`deleteMessage` (or your own state); leave them out and no action renders.
Reply and jump state works the same way: pass `replyTarget`, `replyPreviews`,
`highlightedMessageId`, `hasNewerMessages` and `isLoadingNewer` with
`startReply`, `cancelReply`, `jumpToMessage`, `loadNewerMessages`,
`returnToLatest` and `clearHighlight`, or leave them out and nothing new
renders.

```tsx
import { Alert, Pressable, Text } from 'react-native'
import {
  ConvoKitConversationListView, ConvoKitConversationView, DefaultConvoKitUiClient, conversationPreview,
  unreadBadge, useConvoKitConversation, useConvoKitConversationList,
} from '@convokitapp/react-native-ui'

const uiClient = new DefaultConvoKitUiClient(sdk)

function Room({ roomId }: { roomId: string }) {
  const { controller, state } = useConvoKitConversation({ client: uiClient, conversationId: roomId })
  if (!state.conversation) return null
  return <ConvoKitConversationView
    conversation={state.conversation}
    messages={state.messages}
    currentUserId={state.currentUserId}
    typingUserIds={state.typingUserIds}
    readPositionByUserId={state.readPositionByUserId}
    readAtByUserId={state.readAtByUserId}
    isSending={state.isSending}
    error={state.error}
    onSendMessage={async ({ text }) => (await controller.sendMessage({ text })) !== null}
    onTypingChanged={typing => void controller.updateTyping(typing)}
    onLoadOlder={() => controller.loadOlderMessages()}
    hasOlderMessages={state.hasOlderMessages}
    editingMessage={state.editingMessage}
    onEditMessage={message => controller.startEditing(message.id)}
    onSaveEdit={(_message, text) => controller.saveEdit(text)}
    onCancelEdit={() => controller.cancelEditing()}
    onDeleteMessage={message => controller.deleteMessage(message.id)}
    replyTarget={state.replyTarget}
    replyPreviewByMessageId={state.replyPreviews}
    highlightedMessageId={state.highlightedMessageId}
    hasNewerMessages={state.hasNewerMessages}
    isLoadingNewer={state.isLoadingNewer}
    onReplyToMessage={message => controller.startReply(message.id)}
    onCancelReply={() => controller.cancelReply()}
    onJumpToMessage={messageId => void controller.jumpToMessage(messageId)}
    onLoadNewer={() => controller.loadNewerMessages()}
    onHighlightDismissed={() => controller.clearHighlight()}
    {...(state.windowMode === 'jumped' ? { onReturnToLatest: () => void controller.returnToLatest() } : {})}
    confirmDelete={message => new Promise<boolean>(resolve => Alert.alert(
      'Delete this message?', message.text ?? undefined,
      [{ text: 'Keep', style: 'cancel', onPress: () => resolve(false) }, { text: 'Delete', style: 'destructive', onPress: () => resolve(true) }],
    ))}
  />
}

function Inbox({ onOpen }: { onOpen(roomId: string): void }) {
  const { controller, state } = useConvoKitConversationList({ client: uiClient, activityRefreshWindowMs: 500 })
  return <ConvoKitConversationListView
    conversations={state.conversations}
    summaries={state.summaries}
    currentUserId={state.currentUserId}
    isInitialLoading={state.isInitialLoading}
    isLoadingMore={state.isLoadingMore}
    hasMore={state.hasMore}
    error={state.error}
    onRefresh={() => controller.refresh()}
    onLoadMore={() => controller.loadMore()}
    onConversationSelected={conversation => onOpen(conversation.id)}
    renderItem={({ conversation, summary, currentUserId, onPress }) => {
      const badge = summary ? unreadBadge(summary) : null
      return <Pressable
        onPress={onPress}
        onLongPress={() => { void controller.markUnread(conversation.id).catch(error => Alert.alert(String(error))) }}
        accessibilityLabel={badge ? `Open ${conversation.displayTitle}, ${badge.accessibilityLabel}` : `Open ${conversation.displayTitle}`}
      >
        <Text>{conversation.displayTitle}</Text>
        {summary && <Text>{conversationPreview(conversation, summary, currentUserId) ?? conversation.description}</Text>}
        {badge && <Text>{badge.dot ? 'Unread' : badge.label}</Text>}
      </Pressable>
    }}
  />
}
```

`markUnread` and `clearUnread` reject on a request failure and when the
controller is not active, so keep the `catch`. A `ConversationListController`
you construct yourself (`new ConversationListController({ client })`) drives
the same view; dispose it when the screen unmounts.

## Customization

Every meaningful section can be replaced through render callbacks: the
conversation row, separator, header, message, media block, read receipt,
typing indicator, composer, and the loading, empty and error states.

```tsx
<ConvoKitConversationView
  {...roomProps}
  renderReadReceipt={(_message, readerIds) => <Text>{readerIds.size ? `Seen by ${readerIds.size}` : 'Sent'}</Text>}
  renderMedia={({ media }) => media.type === 'location' ? <MyMap location={media} /> : undefined}
  renderMessage={({ message, isCurrentUser, isEdited, edit, remove, reply, replyPreview, jumpToReplyTarget }) => (
    <View style={{ alignItems: isCurrentUser ? 'flex-end' : 'flex-start' }}>
      {message.replyToMessageId !== undefined && <Pressable accessibilityRole="button" onPress={jumpToReplyTarget}>
        <Text numberOfLines={2}>
          {replyPreview === 'unavailable' ? 'Original message unavailable' : replyPreview?.text ?? ''}
        </Text>
      </Pressable>}
      <Text>{message.text}</Text>
      {isEdited && <Text accessibilityLabel="Edited">(edited)</Text>}
      {reply && <Pressable accessibilityRole="button" onPress={reply}><Text>Reply</Text></Pressable>}
      {edit && <Pressable accessibilityRole="button" onPress={edit}><Text>Edit</Text></Pressable>}
      {remove && <Pressable accessibilityRole="button" onPress={() => void remove()}><Text>Delete</Text></Pressable>}
    </View>
  )}
  renderComposer={({ value, setValue, send, isSending, editing, cancelEdit, replying, cancelReply }) => (
    <View>
      {editing && <View>
        <Text>Editing: {editing.text}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel editing" onPress={cancelEdit}><Text>Cancel</Text></Pressable>
      </View>}
      {replying && <View>
        <Text>Replying to: {replying.text}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel reply" onPress={cancelReply}><Text>Cancel</Text></Pressable>
      </View>}
      <TextInput value={value} onChangeText={setValue} onSubmitEditing={send} />
      <Pressable accessibilityRole="button" disabled={isSending} onPress={send}><Text>{editing ? 'Save' : 'Send'}</Text></Pressable>
    </View>
  )}
/>
```

`send()` saves while `editing` is present and sends otherwise, so a custom
composer needs no branching; `edit` and `remove` are present on a row exactly
when that action is available to the viewer. A custom row's `remove()` asks
`confirmDelete` when the view was given one and otherwise calls
`onDeleteMessage` at once, so the row above owns its confirmation UI unless
the host passes `confirmDelete`; the default row keeps the built-in dialog.
A row's `reply` is present exactly when the viewer may quote it, and
`replyPreview` / `jumpToReplyTarget` only when the row carries a reference: a
`replyPreview` of `undefined` means the quoted parent is not resolved yet, not
that it is gone. `ConvoKitUiProvider` supplies the theme tokens
(`colors.badge` and `colors.highlight` included) that the default rows read
through `useConvoKitTheme`.

Version 0.9.0 requires `@convokitapp/react-native` 0.9.x (peer
`>=0.9.0 <0.10.0`). Publish `@convokitapp/react-native` before publishing this
package.

## Emoji reactions

`ConvoKitConversationView` renders a picker, count chips, and a paged reactor list. Custom rows can use the exported `ReactionBar`. The controller batches visible summaries and refetches after private invalidations or reconnect. Emoji sequences are exact (`👍` differs from `👍🏽`); `READ` members can inspect reactors, while `READ_WRITE` members can toggle their own reaction.
