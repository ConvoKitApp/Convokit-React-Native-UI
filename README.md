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

Version 0.5.0 requires `@convokitapp/react-native` 0.5.x. Publish
`@convokitapp/react-native` before publishing this package.
