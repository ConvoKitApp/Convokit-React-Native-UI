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
typing indicators, read receipts, and media rendering live in shared
controllers. Navigation, safe areas, pickers, downloads, and attachment
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
`unreadCountCapped`, `readPosition`, `lastReadAt`, `activityAt`), and
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
the new theme token `colors.badge` (unset means `primary`).

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

Version 0.6.0 requires `@convokitapp/react-native` 0.6.x. Publish
`@convokitapp/react-native` before publishing this package.
