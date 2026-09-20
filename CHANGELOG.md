# Changelog

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
