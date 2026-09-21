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
edit mode for the caller's own messages, typing indicators, read receipts, and
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
(`MESSAGE_NOT_FOUND`), or the target is deleted while in flight, the controller
retries once with the next newest rendered row; membership failures still
surface as `error`.

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
and drop a pending activity timer. Room controllers keep subscribing to
`onInboxChanged` only.

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
the row and resolves `false`; an adapter without the two members makes both
methods reject. Other devices learn of a change through `onInboxActivity`,
which the list already refetches from. There is no default row action: wire
one through a custom `renderItem` (a long-press, a menu) that calls the
controller returned by `useConvoKitConversationList`, or pass your own
`controller` to `ConvoKitConversationList`. On the legacy path (custom
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
can be cleared. Cancel and a successful save restore the stash and report
typing for it; a failed save keeps the text and edit mode; when the host
leaves edit mode externally (the row was removed) the field keeps user-changed
text and restores the stash only when it is empty or unchanged. Custom
composers receive the additive `editing` (the message) and `cancelEdit` on the
`renderComposer` input (`ComposerContext`) while editing; `send()` saves then,
so no branching is needed.

Controlled views. `ConvoKitMessageListView` accepts `onEditMessage(message)`,
`onDeleteMessage(message)` (`false` reports that nothing was deleted),
`canEditMessage` and `confirmDelete`; `ConvoKitConversationView` adds
`editingMessage`, `onSaveEdit(message, text)` (`false` keeps edit mode and the
text, like `onSendMessage`) and `onCancelEdit`. Without the callbacks nothing
new renders. Custom rows receive `isEdited`, `canEdit`, `canDelete` and, only
while allowed, `edit()` and `remove()` (confirms, then calls
`onDeleteMessage`; resolves whether it was deleted) on `MessageRowContext`.
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

Version 0.8.0 requires `@convokitapp/react-native` 0.8.x (peer
`>=0.8.0 <0.9.0`). Publish `@convokitapp/react-native` before publishing this
package.
