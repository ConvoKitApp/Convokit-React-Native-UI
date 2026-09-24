import {
  covers,
  createClientMessageId,
  readThrough,
  type Conversation,
  type Message,
  type MessageContextPage,
  type MessageEvent,
  type MessageMedia,
  type MessageReactionSummary,
  type ReactionUsersPage,
  type ReadPosition,
  type RealtimeSubscription,
  type ReplyPreview,
} from '@convokitapp/react-native'
import type { ConvoKitUiClient } from './client'
import { closeAll, ObservableStore } from './store'

const pendingPrefix = 'convokit-pending-'
export const isConvoKitPendingMessage = (message: Message): boolean => message.id.startsWith(pendingPrefix)
/** The most rows one `getMessages` page carries: the backend clamps a larger `limit` to 100 silently (the SDK
 * forwards it unchecked), so a page of exactly this many rows is a full page, never proof that nothing older
 * exists.
 */
const maxMessageLimit = 100
/** The longest a quoted parent's text can be: the backend cuts the preview there and sets
 * `textTruncated`, so a preview derived from a row already in the window reads the same.
 */
const replyPreviewTextLimit = 500

/** A resolved quoted parent, or the terminal `'unavailable'`: the parent was missing from a batch that
 * resolved, so it is gone for good (a deleted message never comes back). A missing key is the distinct
 * third state, "not yet resolved", which is what a failed batch leaves behind.
 */
export type ReplyPreviewEntry = ReplyPreview | 'unavailable'

/** Which window the room renders: the live tail (the 0.8 behaviour) or a historical window loaded by
 * `jumpToMessage`. While `jumped`, realtime inserts are recorded but not rendered and no read
 * acknowledgement is issued; `returnToLatest()` is the only way back.
 */
export type ConversationWindowMode = 'live' | 'jumped'

export interface ConversationState {
  conversation: Conversation | null
  messages: readonly Message[]
  typingUserIds: ReadonlySet<string>
  /** Last acknowledgement time per user; kept for custom renderers. */
  readAtByUserId: ReadonlyMap<string, Date>
  /** Monotonic server read positions per user; absent for legacy rows without a position. */
  readPositionByUserId: ReadonlyMap<string, ReadPosition>
  currentUserId: string
  isInitialLoading: boolean
  isLoadingOlder: boolean
  isSending: boolean
  isReconciling: boolean
  hasOlderMessages: boolean
  hasLoaded: boolean
  error: unknown
  /** The 0.8 edit session: the snapshot of the caller's own message being edited, captured by
   * `startEditing` and refreshed only by a conflict; its `revision` is what `saveEdit` sends. Null
   * outside edit mode; cleared when that row is removed.
   */
  editingMessage: Message | null
  /** Whether the adapter implements the 0.8 `editMessage` / `deleteMessage`; without them nothing renders
   * an edit or delete action and `startEditing` is a no-op.
   */
  canEditMessages: boolean
  canDeleteMessages: boolean
  /** The 0.9 reply target: the message the next send quotes, captured by `startReply` and cleared by
   * `cancelReply`, by a successful send, by entering edit mode and when that row is removed. Null when
   * the composer is not replying.
   */
  replyTarget: Message | null
  /** Quoted parents by message id for the rendered replies. A key missing from the map is "not yet
   * resolved" and renders the reference without its text; `'unavailable'` is terminal.
   */
  replyPreviews: ReadonlyMap<string, ReplyPreviewEntry>
  /** The row `jumpToMessage` landed on, for ~2 seconds or until a user-initiated scroll. */
  highlightedMessageId: string | null
  /** `live` renders the newest page; `jumped` a historical window loaded around a jump target. */
  windowMode: ConversationWindowMode
  /** Whether rows newer than the rendered window exist on the server; always false while `live`. */
  hasNewerMessages: boolean
  isLoadingNewer: boolean
  /** Whether the adapter implements the 0.9 `getMessageContext`; false also once a 0.8 backend answered
   * its uncoded 404, after which no jump affordance renders for the life of the controller.
   */
  canJumpToMessages: boolean
  /** Whether the adapter implements the 0.9 `getReplyPreviews`; false also once a 0.8 backend answered
   * its uncoded 404. Quoted blocks then render the reference without its text.
   */
  canResolveReplyPreviews: boolean
  reactionSummaries: ReadonlyMap<string, MessageReactionSummary>
  canReact: boolean
}

export interface ConversationControllerOptions {
  conversationId: string
  client: ConvoKitUiClient
  messagePageSize?: number
  markReadOnLoad?: boolean
  markReadOnReceive?: boolean
  typingTimeoutMs?: number
  autoLoad?: boolean
  /** Max wait before a burst of live inserts resolves its quoted parents in one batch; default 250,
   * 0 resolves on the next tick.
   */
  replyPreviewWindowMs?: number
  /** How long a jumped-to row stays highlighted; default 2000. */
  highlightDurationMs?: number
}

interface MessageCursor { id: string; createdAt: Date }

/** Message cursor order: (createdAt, id) with ids compared by code units, matching the server. */
function compareCursor(left: MessageCursor, right: MessageCursor): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

function sortMessages(messages: Iterable<Message>): Message[] {
  return [...messages].sort(compareCursor)
}

/** Row precedence: when both rows carry a usable revision and they differ, the higher one wins and a lower
 * one never overwrites; equal revisions (and rows without one: pending rows, 0.7 backends where every row
 * is 0) fall back to the later `updatedAt ?? createdAt`, ties to the incoming row.
 */
function newer(left: Message, right: Message): Message {
  if (usableRevision(left) && usableRevision(right) && left.revision !== right.revision) {
    return right.revision > left.revision ? right : left
  }
  const leftTime = (left.updatedAt ?? left.createdAt).getTime()
  const rightTime = (right.updatedAt ?? right.createdAt).getTime()
  return rightTime >= leftTime ? right : left
}
/** A revision takes part in precedence only as a non-negative integer; consumer-built rows without one keep
 * the timestamp rule. Two usable revisions that differ always include one above 0.
 */
function usableRevision(row: Message): boolean {
  return Number.isInteger(row.revision) && row.revision >= 0
}

function errorField(error: unknown, field: 'code' | 'status'): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[field] : undefined
}
/** A targeted read whose message the server no longer knows; membership failures carry no code. */
const isTargetMiss = (error: unknown): boolean => errorField(error, 'code') === 'MESSAGE_NOT_FOUND'
const isNotFound = (error: unknown): boolean => errorField(error, 'status') === 404
/** A 0.9 route a 0.8 backend does not serve: Express answers an unmatched route with an HTML body and no
 * JSON `code`, which the SDK reports as `HTTP_ERROR`. A coded `MESSAGE_NOT_FOUND` is a real missing
 * target and never trips this, so a deleted quoted message can never retire the feature.
 */
const isMissingEndpoint = (error: unknown): boolean => isNotFound(error) && !isTargetMiss(error)
/** A stale-revision rejection of an author edit (the 0.8 backend's 409 `REVISION_CONFLICT`). */
const isConflict = (error: unknown): boolean =>
  errorField(error, 'code') === 'REVISION_CONFLICT' || errorField(error, 'status') === 409
/** The local conflict: a newer row for the edited id reached the store, no request involved. */
const conflictError = (): Error =>
  Object.assign(new Error('Message was changed since it was loaded'), { code: 'REVISION_CONFLICT' })
const unsupported = (member: string): Error =>
  new Error(`This ConvoKitUiClient adapter does not implement ${member} (0.8)`)

/** Readers of a message under the unified rule: a user's read position when known, otherwise the
 * acknowledgement time. The sender never reads their own message and pending rows have no readers.
 */
export function resolveReaderIds(
  message: Message,
  readPositionByUserId: ReadonlyMap<string, ReadPosition> = new Map(),
  readAtByUserId: ReadonlyMap<string, Date> = new Map(),
): ReadonlySet<string> {
  const readerIds = new Set<string>()
  if (isConvoKitPendingMessage(message)) return readerIds
  for (const id of new Set([...readPositionByUserId.keys(), ...readAtByUserId.keys()])) {
    if (id === message.senderId) continue
    const reader = { readPosition: readPositionByUserId.get(id) ?? null, lastReadAt: readAtByUserId.get(id) ?? null }
    if (readThrough(reader, message)) readerIds.add(id)
  }
  return readerIds
}

/** The quoted parent of a reply, derived from a row that is already in the loaded window: the same shape
 * the backend serves, cut at the same 500 characters, so a derived preview and a fetched one read alike
 * and a parent on screen costs no request.
 */
function derivePreview(message: Message): ReplyPreview {
  const text = message.text
  return {
    id: message.id, conversationId: message.conversationId, senderId: message.senderId,
    text: text === null ? null : text.slice(0, replyPreviewTextLimit),
    textTruncated: text !== null && text.length > replyPreviewTextLimit,
    createdAt: message.createdAt, revision: message.revision, mediaCount: message.media.length,
  }
}

export class ConversationController extends ObservableStore<ConversationState> {
  readonly conversationId: string
  readonly messagePageSize: number
  private conversation: Conversation | null = null
  private messages = new Map<string, Message>()
  private deleted = new Set<string>()
  private typing = new Set<string>()
  private reads = new Map<string, Date>()
  private positions = new Map<string, ReadPosition>()
  private subscriptions = new Set<RealtimeSubscription>()
  private remoteTypingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private localTypingTimer?: ReturnType<typeof setTimeout>
  private localTypingRenewal?: ReturnType<typeof setTimeout>
  private generation = 0
  private initialLoading = false
  private loadingOlder = false
  private sending = false
  private reconciling = false
  private refreshQueued = false
  private hasOlder = true
  private hasLoaded = false
  private error: unknown = null
  private disposed = false
  private sessionIdentity: object | null = null
  // The 0.8 edit session: the snapshot whose revision every save sends (refreshed only by a conflict), the id
  // whose save is in flight (its row images wait for the response instead of raising a conflict), and the
  // adapter support decided once at construction (`listInbox` precedent).
  private editing: Message | null = null
  private saving: string | null = null
  private readonly supportsEdit: boolean
  private readonly supportsDelete: boolean
  // Acknowledgements: visible until the platform says otherwise, one request in flight, a boolean
  // follow-up resolved at send time, and the ids the server refused so a retry skips them.
  private visible = true
  private acknowledging = false
  private followUp = false
  private suppressed = false
  private inFlight: MessageCursor | null = null
  private acknowledged: MessageCursor | null = null
  private unacknowledgeable = new Set<string>()
  // Private state captured once per open, the first time `conversation` goes from null to a DTO (the
  // `loadInitial` happy path, or a reconcile after a transient first-load failure), never from a later
  // refresh: the version every targeted acknowledgement of this open sends (undefined from a 0.6 backend,
  // which serves no `membership`), the version an opened-but-empty marked room clears its marker with
  // (null once issued or when nothing was marked), and whether a confirmed row was ever rendered.
  private openedVersion: number | undefined
  private pendingClear: number | null = null
  private rendered = false
  // 0.9 quoted replies and jump-to-message. `deferred` holds the realtime rows a jumped window records
  // but does not render (the `messages` map IS the rendered set), drained when the window goes live.
  // `previews` caches quoted parents, `stalePreviews` the entries a signal invalidated, and `windowPaged`
  // whether the jumped window has been paged (the reconcile anchor stops being the jump target then).
  private replyTarget: Message | null = null
  private deferred = new Map<string, Message>()
  private previews = new Map<string, ReplyPreviewEntry>()
  private stalePreviews = new Set<string>()
  private previewTimer?: ReturnType<typeof setTimeout>
  private resolvingPreviews = false
  private previewsQueued = false
  private highlighted: string | null = null
  private highlightTimer?: ReturnType<typeof setTimeout>
  private windowMode: ConversationWindowMode = 'live'
  private windowPaged = false
  private jumpAnchorId: string | null = null
  private olderCursor: string | null = null
  private newerCursor: string | null = null
  private hasNewer = false
  private loadingNewer = false
  private jumping = false
  // The jumped window owes its own reconcile separately from `refreshQueued`, which stays set so the
  // tail-anchored reconcile still runs on the return to live.
  private windowRefreshQueued = false
  private supportsJump: boolean
  private supportsReplyPreviews: boolean
  private readonly supportsReactions: boolean
  private reactions = new Map<string, MessageReactionSummary>()
  private reactionDirty = new Set<string>()
  private reactionEpoch = new Map<string, number>()
  private reactionTimer?: ReturnType<typeof setTimeout>
  private loadingReactions = false

  constructor(private options: ConversationControllerOptions) {
    super()
    this.conversationId = options.conversationId.trim()
    if (!this.conversationId) throw new Error('conversationId is required')
    this.messagePageSize = options.messagePageSize ?? 30
    if (this.messagePageSize < 1 || this.messagePageSize > 100) {
      throw new RangeError('messagePageSize must be between 1 and 100')
    }
    this.supportsEdit = typeof options.client.editMessage === 'function'
    this.supportsDelete = typeof options.client.deleteMessage === 'function'
    this.supportsJump = typeof options.client.getMessageContext === 'function'
    this.supportsReplyPreviews = typeof options.client.getReplyPreviews === 'function'
    this.supportsReactions = typeof options.client.getReactionSummaries === 'function'
      && typeof options.client.addReaction === 'function' && typeof options.client.removeReaction === 'function'
      && typeof options.client.listReactionUsers === 'function'
    if (options.autoLoad !== false) void this.loadInitial()
  }

  getSnapshot = (): ConversationState => ({
    conversation: this.conversation,
    messages: sortMessages(this.messages.values()),
    typingUserIds: new Set(this.typing),
    readAtByUserId: new Map(this.reads),
    readPositionByUserId: new Map(this.positions),
    currentUserId: this.options.client.currentUserId,
    isInitialLoading: this.initialLoading,
    isLoadingOlder: this.loadingOlder,
    isSending: this.sending,
    isReconciling: this.reconciling,
    hasOlderMessages: this.hasOlder,
    hasLoaded: this.hasLoaded,
    error: this.error,
    editingMessage: this.editing,
    canEditMessages: this.supportsEdit,
    canDeleteMessages: this.supportsDelete,
    replyTarget: this.replyTarget,
    replyPreviews: new Map(this.previews),
    highlightedMessageId: this.highlighted,
    windowMode: this.windowMode,
    hasNewerMessages: this.hasNewer,
    isLoadingNewer: this.loadingNewer,
    canJumpToMessages: this.supportsJump,
    canResolveReplyPreviews: this.supportsReplyPreviews,
    reactionSummaries: new Map(this.reactions), canReact: this.supportsReactions,
  })

  protected override emit(): void {
    if (this.supportsReactions && this.current(this.generation)) {
      const visible = new Set([...this.messages.values()].filter(row => !isConvoKitPendingMessage(row)).map(row => row.id))
      for (const id of this.reactions.keys()) if (!visible.has(id)) this.reactions.delete(id)
      this.queueReactionRefresh([...visible].filter(id => !this.reactions.has(id)))
    }
    super.emit()
  }

  private queueReactionRefresh(ids: readonly string[]): void {
    if (!this.supportsReactions || !this.current(this.generation)) return
    for (const id of ids) if (this.messages.has(id) && !isConvoKitPendingMessage(this.messages.get(id)!)) {
      this.reactionDirty.add(id)
      this.reactionEpoch.set(id, (this.reactionEpoch.get(id) ?? 0) + 1)
    }
    this.scheduleReactionRefresh()
  }
  private scheduleReactionRefresh(): void {
    if (!this.reactionDirty.size || this.reactionTimer || !this.current(this.generation)) return
    this.reactionTimer = setTimeout(() => { this.reactionTimer = undefined; void this.flushReactionRefresh() }, 25)
  }
  private async flushReactionRefresh(): Promise<void> {
    const fetch = this.options.client.getReactionSummaries
    if (!this.current(this.generation) || !fetch || this.loadingReactions || !this.reactionDirty.size) return
    const generation = this.generation
    const ids = [...this.reactionDirty]
    const epochs = new Map(ids.map(id => [id, this.reactionEpoch.get(id)]))
    this.reactionDirty.clear(); this.loadingReactions = true
    try {
      const rows = await fetch.call(this.options.client, this.conversationId, ids)
      if (!this.current(generation)) return
      const byId = new Map(rows.map(row => [row.messageId, row]))
      for (const id of ids) {
        if (!this.messages.has(id) || epochs.get(id) !== this.reactionEpoch.get(id)) continue
        this.reactions.set(id, byId.get(id) ?? { messageId: id, reactions: [], hasMore: false })
      }
      this.emit()
    } catch (cause) {
      if (this.current(generation)) {
        // Keep an empty snapshot until an explicit invalidation or reconnect;
        // an error must not make emit() retry the endpoint in a tight loop.
        for (const id of ids) if (this.messages.has(id)) this.reactions.set(id, { messageId: id, reactions: [], hasMore: false })
        this.error = cause; this.emit()
      }
    }
    finally { if (generation === this.generation) { this.loadingReactions = false; this.scheduleReactionRefresh() } }
  }

  async toggleReaction(messageId: string, emoji: string): Promise<boolean> {
    if (!this.current(this.generation) || !this.supportsReactions || this.role() === 'READ'
      || !this.messages.has(messageId) || isConvoKitPendingMessage(this.messages.get(messageId)!)) return false
    const selected = this.reactions.get(messageId)?.reactions.some(row => row.emoji === emoji && row.reactedByMe) ?? false
    const generation = this.generation
    try {
      const mutate = selected ? this.options.client.removeReaction! : this.options.client.addReaction!
      await mutate.call(this.options.client, messageId, emoji)
      if (!this.current(generation)) return false
      this.queueReactionRefresh([messageId]); return true
    } catch (cause) {
      if (this.current(generation)) { this.error = cause; this.emit(); this.queueReactionRefresh([messageId]) }
      return false
    }
  }

  async listReactionUsers(messageId: string, emoji: string, cursor?: string): Promise<ReactionUsersPage> {
    if (!this.current(this.generation) || !this.options.client.listReactionUsers) throw new Error('Reactions are unavailable')
    const generation = this.generation
    const page = await this.options.client.listReactionUsers(messageId, emoji, { ...(cursor ? { cursor } : {}), limit: 30 })
    if (!this.current(generation)) throw new Error('Session changed while loading reactions')
    return page
  }

  readerIdsFor(message: Message): ReadonlySet<string> {
    return resolveReaderIds(message, this.positions, this.reads)
  }

  async loadInitial(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    await this.clearSubscriptions()
    this.messages.clear(); this.deleted.clear(); this.typing.clear(); this.reads.clear(); this.positions.clear()
    this.clearReactions()
    this.resetAcknowledgements(); this.editing = null; this.saving = null; this.refreshQueued = false
    this.resetWindow()
    this.conversation = null; this.error = null; this.hasOlder = true; this.initialLoading = true; this.emit()
    this.sessionIdentity = this.options.client.sessionIdentity
    try {
      if (!this.sessionIdentity) throw new Error('Connect a ConvoKit user before loading a conversation')
      const [conversation, page] = await Promise.all([
        this.options.client.getConversation(this.conversationId),
        this.options.client.getMessages({ conversationId: this.conversationId, limit: this.messagePageSize, offset: 0 }),
      ])
      if (!this.current(generation)) return
      this.assertRows(page)
      this.conversation = conversation
      this.capture(conversation)
      this.mergeParticipantReads(conversation)
      this.merge(page); this.hasOlder = page.length === this.messagePageSize
      this.bind(generation); this.emit()
      // Render first, then acknowledge what was rendered.
      if (this.options.markReadOnLoad !== false) await this.acknowledge()
    } catch (error) { if (this.current(generation)) this.error = error }
    finally {
      if (this.current(generation)) {
        this.initialLoading = false; this.hasLoaded = true; this.emit(); this.flushRefresh(); this.resolvePreviews()
      }
    }
  }

  async refresh(): Promise<void> {
    if (!this.hasLoaded) return this.loadInitial()
    if (this.disposed) return
    // The newest-N reconcile is anchored at the live tail, so it is replaced, not dropped, while jumped
    // (E5a) — for a caller that asks for one directly (the default header's refresh control, a host)
    // exactly as for a queued realtime signal. Routing it through the same gate gives the jumped window
    // its one bounded re-read and leaves the tail reconcile owed for the return to live (E5b).
    if (this.windowMode === 'jumped') { this.queueRefresh(); return }
    if (this.reconciling) return
    const generation = this.generation; this.reconciling = true; this.emit()
    // The reconciled window: every rendered row, up to the server's page cap (asking for more than the cap
    // would be clamped silently, and a short page then could not tell a deletion from the clamp). The
    // confirmed rows known when the reconcile was requested; a row that arrives during the fetch is not one
    // of them, so it can never be tombstoned by a page fetched before it existed.
    const limit = Math.min(Math.max(this.messages.size, this.messagePageSize), maxMessageLimit)
    const known = [...this.messages.values()].filter(row => !isConvoKitPendingMessage(row))
    try {
      const [conversation, page] = await Promise.all([
        this.options.client.getConversation(this.conversationId),
        this.options.client.getMessages({ conversationId: this.conversationId, limit, offset: 0 }),
      ])
      if (!this.current(generation)) return
      this.assertRows(page)
      // A reconcile after a failed first load is this open's first DTO; replacing one never recaptures.
      const opening = this.conversation === null
      this.conversation = conversation
      if (opening) this.capture(conversation)
      // A jump replaced the window while this page was in flight. The page is the live tail: installing
      // it would render the newest rows inside a historical window, and its boundary would tombstone
      // rows it was never meant to cover. Nothing of it is installed and the reconcile stays owed, so it
      // runs again on the return to live (E5b); the jumped window has its own bounded re-read.
      if (this.windowMode !== 'live') {
        this.mergeParticipantReads(conversation); this.error = null; this.refreshQueued = true
        return
      }
      // The page is the rendered window, but each row still merges under precedence (D11): a page fetched
      // before an edit never rewinds the newer row the edit response or its UPDATE image already brought.
      const canonical = new Map<string, Message>()
      for (const row of page) {
        if (this.deleted.has(row.id)) continue
        const existing = this.messages.get(row.id)
        canonical.set(row.id, existing ? newer(existing, row) : row)
      }
      for (const row of this.messages.values()) {
        if (isConvoKitPendingMessage(row)) canonical.set(row.id, row)
      }
      this.messages = canonical
      // A row the page no longer carries is no longer rendered: its edit session ends with it.
      if (this.editing && !canonical.has(this.editing.id)) this.editing = null
      // A known row missing from the reconciled range was deleted while the client was away (a missed
      // `message_deleted`): tombstone it so a late edit or send response, a hydration or a row image cannot
      // re-add it. A full page only reconciles from its oldest row on; rows older than that are outside
      // the window (not refetched, not deleted) and are never tombstoned: they left the view, and the next
      // history page brings them back, so the history is open again even if it had been exhausted.
      const boundary = page.length < limit ? null : page.reduce<MessageCursor | null>(
        (oldest, row) => (!oldest || compareCursor(row, oldest) < 0 ? row : oldest), null,
      )
      for (const row of known) {
        if (canonical.has(row.id) || this.deleted.has(row.id)) continue
        if (boundary && compareCursor(row, boundary) < 0) { this.hasOlder = true; continue }
        this.remove(row.id)
      }
      this.mergeParticipantReads(conversation)
      this.error = null
      this.detectConflict()
    } catch (error) { if (this.current(generation)) this.error = error }
    finally {
      if (this.current(generation)) { this.reconciling = false; this.emit(); this.flushRefresh(); this.resolvePreviews() }
    }
  }

  async loadOlderMessages(): Promise<void> {
    if (this.loadingOlder || !this.hasOlder || this.disposed) return
    const generation = this.generation
    const oldest = sortMessages(this.messages.values()).find(row => !isConvoKitPendingMessage(row))
    // Which route this page takes is decided once, before the request: it picks the branch and it is
    // what tells a 0.9-only route's absence (a 0.8 backend) from an ordinary `getMessages` failure.
    const jumped = this.windowMode === 'jumped'
    this.loadingOlder = true; this.error = null; this.emit()
    try {
      // A jumped window pages through the context cursors on both ends; the keyset `getMessages` walk is
      // anchored at the live tail and would reopen the history from the wrong boundary.
      if (jumped) {
        const cursor = this.olderCursor
        if (!cursor) { this.hasOlder = false; return }
        const page = await this.contextPage({ olderCursor: cursor })
        if (!this.current(generation)) return
        // The window went live while the page was in flight (a return to latest): these rows and these
        // cursors belong to a window that is no longer rendered, so none of them is installed.
        if (this.windowMode !== 'jumped') return
        this.validateContextPage(page, this.messagePageSize)
        this.merge(page.messages)
        this.olderCursor = page.olderCursor; this.hasOlder = page.olderCursor !== null
        this.windowPaged = true
        return
      }
      const page = await this.options.client.getMessages({
        conversationId: this.conversationId, limit: this.messagePageSize, offset: 0,
        ...(oldest ? { beforeCreatedAt: oldest.createdAt, beforeId: oldest.id } : {}),
      })
      if (!this.current(generation)) return
      this.assertRows(page); this.merge(page); this.hasOlder = page.length === this.messagePageSize
    } catch (error) {
      if (!this.current(generation)) return
      // Only the 0.9 context route can be one a 0.8 backend does not serve. `GET /api/v1/messages`
      // answers a membership miss with an uncoded 404 of its own, which must stay an ordinary error
      // rather than silently retiring the jump affordance.
      if (jumped) this.recordWindowError(error)
      else this.error = error
    }
    finally {
      if (this.current(generation)) { this.loadingOlder = false; this.emit(); this.flushRefresh(); this.resolvePreviews() }
    }
  }

  /** Page the rows immediately newer than a jumped window, through the stored `newerCursor`. A no-op in
   * `live` mode, where the newest page is already rendered. When the response reports no newer cursor the
   * window does not flip to `live` on the spot: that answer was only true at the server's query time and
   * realtime inserts have been deferred throughout the round trip, so `returnToLatest()` runs instead.
   */
  async loadNewerMessages(): Promise<void> {
    if (this.windowMode !== 'jumped' || this.loadingNewer || !this.hasNewer || this.disposed) return
    const cursor = this.newerCursor
    if (!cursor) { this.hasNewer = false; return }
    const generation = this.generation
    let reachedTail = false
    this.loadingNewer = true; this.error = null; this.emit()
    try {
      const page = await this.contextPage({ newerCursor: cursor })
      if (!this.current(generation)) return
      // The window went live while the page was in flight: its cursors no longer describe what is
      // rendered, and `hasNewerMessages` is always false in `live`. Today only `returnToLatest()` makes
      // that flip and it refuses to start while `loadingNewer`, so this is the same guard the older
      // page and the window re-read need, kept here so the three window-scoped paths do not depend on
      // one shared flag for their correctness.
      if (this.windowMode !== 'jumped') return
      this.validateContextPage(page, this.messagePageSize)
      this.merge(page.messages)
      this.newerCursor = page.newerCursor; this.hasNewer = page.newerCursor !== null
      this.windowPaged = true
      reachedTail = page.newerCursor === null
    } catch (error) { if (this.current(generation)) this.recordWindowError(error) }
    finally {
      if (this.current(generation)) { this.loadingNewer = false; this.emit(); this.flushRefresh(); this.resolvePreviews() }
    }
    if (reachedTail && this.current(generation)) await this.returnToLatest()
  }

  async sendMessage(input: { text?: string; media?: MessageMedia[] }): Promise<Message | null> {
    const text = input.text?.trim()
    const media = input.media ?? []
    if ((!text || !text.length) && !media.length || this.sending || this.disposed) return null
    // A send is confined to the live window: a pending row in a historical window would be stranded by
    // the next replacement. The reply target survives the switch, so the quote is kept; when the return
    // fails nothing is sent, `isSending` never turns on and the draft is left to the composer. A send
    // is never refused because of a jump — E4b resolves the collision the other way round, and
    // `jumpToMessage` abandons its replacement instead.
    if (this.windowMode === 'jumped' && !await this.returnToLatest()) return null
    if (this.disposed || this.sending) return null
    const generation = this.generation
    const clientMessageId = createClientMessageId()
    const replyToMessageId = this.replyTarget?.id
    const pending: Message = {
      id: `${pendingPrefix}${clientMessageId}`, clientMessageId,
      conversationId: this.conversationId, senderId: this.options.client.currentUserId,
      text: text || null, media, createdAt: new Date(), updatedAt: null, revision: 0,
      // Stamped on the optimistic row so the quoted block renders before acknowledgement.
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    }
    this.messages.set(pending.id, pending); this.sending = true; this.error = null; this.emit()
    try {
      const confirmed = await this.options.client.sendMessage({
        conversationId: this.conversationId, clientMessageId,
        ...(text ? { text } : {}), ...(media.length ? { media } : {}),
        ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
      })
      if (!this.current(generation)) return null
      if (confirmed.conversationId !== this.conversationId || confirmed.senderId !== pending.senderId ||
          confirmed.clientMessageId && confirmed.clientMessageId !== clientMessageId) {
        throw new Error('Send response does not match the pending message')
      }
      this.messages.delete(pending.id)
      if (!this.deleted.has(confirmed.id)) this.merge([confirmed])
      if (this.replyTarget?.id === replyToMessageId) this.replyTarget = null
      await this.updateTyping(false)
      this.resolvePreviews()
      return this.messages.get(confirmed.id) ?? confirmed
    } catch (error) {
      if (this.current(generation)) {
        const canonical = [...this.messages.values()].find(row => row.clientMessageId === clientMessageId && !isConvoKitPendingMessage(row))
        this.messages.delete(pending.id)
        if (canonical) return canonical
        this.error = error
      }
      return null
    } finally { if (this.current(generation)) { this.sending = false; this.emit() } }
  }

  /** Enter edit mode on one of the caller's own confirmed messages: the current row becomes the snapshot
   * whose `revision` every save of this session sends. A no-op for foreign, pending, removed or unknown
   * rows, for a `READ` role when the conversation reports one, and for adapters without `editMessage`.
   */
  startEditing(messageId: string): void {
    if (!this.supportsEdit || this.disposed) return
    const row = this.messages.get(messageId)
    if (!row || !this.editable(row) || this.role() === 'READ') return
    // Editing and replying are mutually exclusive: one composer, one modal state.
    this.editing = row; this.replyTarget = null; this.error = null; this.emit()
  }

  /** Leave edit mode without a request. */
  cancelEditing(): void {
    if (!this.editing) return
    this.editing = null; this.emit()
  }

  /** Quote one of the room's rendered messages in the next send: any member's row, not only the caller's
   * own. A no-op for pending, removed or unknown rows and for a `READ` role when the conversation reports
   * one. Entering reply mode leaves edit mode. The reference is write-once, so it is sent with the message
   * and never changed afterwards.
   */
  startReply(messageId: string): void {
    if (this.disposed) return
    const row = this.messages.get(messageId)
    if (!row || isConvoKitPendingMessage(row) || this.deleted.has(row.id) || this.role() === 'READ') return
    this.replyTarget = row; this.editing = null; this.error = null; this.emit()
  }

  /** Drop the reply target without a request; the next send carries no quote. */
  cancelReply(): void {
    if (!this.replyTarget) return
    this.replyTarget = null; this.emit()
  }

  /** Show a message, loading it when it is outside the rendered window. A row already in the window is
   * only highlighted; otherwise one `getMessageContext` centred on the id replaces the window, the store
   * enters `jumped` mode and the cursors come from the response. A jump is a window operation, never a
   * re-open: the acknowledgement floor, the captured private state, the tombstones and the edit session
   * all survive it, and no read is acknowledged while jumped. A coded `MESSAGE_NOT_FOUND` is the
   * guaranteed answer for a quoted message that was deleted, so it marks the preview `'unavailable'`
   * instead of surfacing an error; any other failure leaves the window untouched and sets `error`. A
   * no-op while a send is in flight, so a replacement can never strand a pending row. Resolves whether
   * the target is now rendered.
   */
  async jumpToMessage(messageId: string): Promise<boolean> {
    const id = messageId.trim()
    if (!id || this.disposed || this.sending || this.jumping) return false
    if (this.messages.has(id)) { this.highlight(id); this.emit(); return true }
    const context = this.options.client.getMessageContext
    if (!this.supportsJump || typeof context !== 'function') return false
    const generation = this.generation
    this.jumping = true; this.error = null; this.emit()
    try {
      const page = await this.contextPage({ messageId: id })
      if (!this.current(generation)) return false
      // E4b's guard is re-checked after the round trip, not only at entry: a send that started while
      // the context page was in flight owns a pending row in the live window, and a replacement
      // installs exactly the response rows (E5d), which would strand it.
      if (this.disposed || this.sending) return false
      this.validateContextPage(page, this.messagePageSize, id)
      this.replaceWindow(page.messages)
      this.windowMode = 'jumped'; this.windowPaged = false; this.jumpAnchorId = id
      this.olderCursor = page.olderCursor; this.newerCursor = page.newerCursor
      this.hasOlder = page.olderCursor !== null; this.hasNewer = page.newerCursor !== null
      // Rows recorded by an earlier jumped window are kept: they belong to the live tail either way and
      // the return to live is what renders them.
      this.highlight(id)
      return true
    } catch (error) {
      if (!this.current(generation)) return false
      if (isTargetMiss(error)) { this.previews.set(id, 'unavailable'); this.stalePreviews.delete(id); return false }
      this.recordWindowError(error)
      return false
    } finally {
      if (this.current(generation)) { this.jumping = false; this.emit(); this.resolvePreviews() }
    }
  }

  /** Leave a jumped window and render the newest page again through the normal live loader. The mode
   * flips to `live` before the request goes out, so inserts arriving during it merge under the usual
   * precedence, and the rows deferred while jumped join the rendered set (and are acknowledged) at that
   * moment. A failed reload puts the window back exactly as it was and keeps the affordance: the store
   * never lands in `live` on an unreloaded window. Resolves whether the newest page is rendered.
   */
  async returnToLatest(): Promise<boolean> {
    if (this.disposed) return false
    if (this.windowMode === 'live') return true
    if (this.loadingNewer) return false
    const generation = this.generation
    const replaced = new Set(this.messages.keys())
    const restore = {
      older: this.olderCursor, newer: this.newerCursor, hasOlder: this.hasOlder, hasNewer: this.hasNewer,
      paged: this.windowPaged, anchor: this.jumpAnchorId,
    }
    this.windowMode = 'live'
    this.olderCursor = null; this.newerCursor = null; this.hasNewer = false
    this.windowPaged = false; this.jumpAnchorId = null
    this.drainDeferred()
    this.loadingNewer = true; this.error = null; this.emit()
    try {
      const page = await this.options.client.getMessages({
        conversationId: this.conversationId, limit: this.messagePageSize, offset: 0,
      })
      if (!this.current(generation)) return false
      this.assertRows(page)
      // The newest page replaces the historical rows; rows that joined the rendered set after the flip
      // (the drained ones and any live insert) are kept, exactly as `loadInitial()` tolerates a row that
      // arrives while its page is in flight.
      const arrived = [...this.messages.values()].filter(row => !replaced.has(row.id))
      this.replaceWindow(page)
      for (const row of arrived) if (!this.deleted.has(row.id)) this.store(row)
      this.hasOlder = page.length === this.messagePageSize
      return true
    } catch (error) {
      if (!this.current(generation)) return false
      this.windowMode = 'jumped'
      this.olderCursor = restore.older; this.newerCursor = restore.newer
      this.hasOlder = restore.hasOlder; this.hasNewer = restore.hasNewer
      this.windowPaged = restore.paged; this.jumpAnchorId = restore.anchor
      this.redefer(replaced)
      // The reload is the ordinary live `getMessages` loader, never a 0.9 route: a failure surfaces and
      // the jump affordance stays (E6b).
      this.error = error
      return false
    } finally {
      if (this.current(generation)) { this.loadingNewer = false; this.emit(); this.flushRefresh(); this.resolvePreviews() }
    }
  }

  /** Clear the jump highlight before its timer, for a user-initiated scroll. */
  clearHighlight(): void {
    if (this.highlighted === null) return
    this.clearHighlightTimer(); this.highlighted = null; this.emit()
  }

  /** Save the edit session: the trimmed text (empty clears the caption of a message with attachments; a
   * text-only message is never saved empty, no request) is sent with the snapshot's revision, never the
   * live row's. Success merges the response under the deletion and precedence guards, clears edit mode
   * and resolves `true`. A stale revision (409 `REVISION_CONFLICT`) reloads the row once: the row shows
   * the new content, the snapshot is refreshed so the next save carries the fresh revision, `error`
   * carries the conflict, and the edited text is left to the composer. A reload or a save that answers
   * `MESSAGE_NOT_FOUND` removes the row and leaves edit mode. Any other failure (a 0.7 backend's uncoded
   * 404, 403, network) sets `error` and keeps the row and the session; every failure resolves `false`.
   * While the save is in flight, row images for the edited id (its own UPDATE image often beats the
   * response) merge without raising a conflict: a success ends edit mode, a 409 reloads the row, and any
   * other failure re-checks the rendered row so a genuinely newer one is a conflict after all.
   */
  async saveEdit(text: string): Promise<boolean> {
    const edit = this.options.client.editMessage
    if (typeof edit !== 'function') throw unsupported('editMessage')
    const snapshot = this.editing
    if (!snapshot || this.saving !== null || this.disposed) return false
    const trimmed = text.trim()
    const normalized = trimmed === '' ? null : trimmed
    if (normalized === null && !snapshot.media.length) return false
    const generation = this.generation
    const id = snapshot.id
    this.saving = id; this.error = null; this.emit()
    try {
      const row = await edit.call(this.options.client, id, { text: normalized, revision: snapshot.revision })
      if (!this.current(generation)) return false
      if (row.id !== id || row.conversationId !== this.conversationId) {
        throw new Error('Edit response does not match the edited message')
      }
      // Leave edit mode first so the response is not read as a conflict against its own snapshot; a late
      // response for a row removed meanwhile is dropped, edit mode was left with the removal.
      if (this.editing?.id === id) this.editing = null
      if (!this.deleted.has(id)) this.store(row)
      this.error = null
      return true
    } catch (error) {
      if (!this.current(generation) || this.deleted.has(id)) return false
      this.saving = null
      if (isConflict(error)) await this.reloadConflict(id, error, generation)
      else if (isTargetMiss(error)) { this.remove(id); this.error = error }
      else {
        this.error = error
        // A newer row image that arrived during the failed request is a conflict after all.
        this.detectConflict()
      }
      return false
    } finally { if (this.current(generation)) { this.saving = null; this.emit() } }
  }

  /** Delete one of the caller's own confirmed messages through the adapter. Success, or a server that no
   * longer knows the message (`MESSAGE_NOT_FOUND`), tombstones and removes the row (leaving edit mode when
   * it was that row) and resolves `true`; any other failure sets `error`, keeps the row and resolves
   * `false`. Never removes a row before the server answers.
   */
  async deleteMessage(messageId: string): Promise<boolean> {
    const remove = this.options.client.deleteMessage
    if (typeof remove !== 'function') throw unsupported('deleteMessage')
    const row = this.messages.get(messageId)
    if (!row || !this.editable(row) || this.disposed) return false
    const generation = this.generation
    this.error = null; this.emit()
    try { await remove.call(this.options.client, messageId) }
    catch (error) {
      if (!this.current(generation)) return false
      if (!isTargetMiss(error)) { this.error = error; this.emit(); return false }
    }
    if (!this.current(generation)) return false
    this.remove(messageId); this.emit()
    return true
  }

  /** Acknowledge through the newest rendered message (clearing the caller's unread marker when the version
   * captured at open is still current), or clear the marker of a marked room that rendered nothing.
   * Deferred while hidden; coalesced with other requests.
   */
  markRead(): Promise<void> { return this.acknowledge() }

  /** Report platform visibility. Hidden defers acknowledgements; becoming visible re-issues a deferred one. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (visible && this.suppressed) { this.suppressed = false; void this.acknowledge() }
  }

  async updateTyping(isTyping: boolean): Promise<void> {
    clearTimeout(this.localTypingTimer)
    if (isTyping) {
      this.localTypingTimer = setTimeout(() => { void this.updateTyping(false) }, this.typingTimeout)
      if (this.localTypingRenewal) return
      this.localTypingRenewal = setTimeout(() => { this.localTypingRenewal = undefined }, this.typingTimeout / 2)
    } else {
      clearTimeout(this.localTypingRenewal); this.localTypingRenewal = undefined
    }
    try { await this.options.client.sendTyping({ conversationId: this.conversationId, isTyping }) }
    catch (error) { if (!this.disposed) { this.error = error; this.emit() } }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; ++this.generation
    clearTimeout(this.localTypingTimer); clearTimeout(this.localTypingRenewal)
    this.clearPreviewTimer(); this.clearHighlightTimer()
    this.clearReactions()
    for (const timer of this.remoteTypingTimers.values()) clearTimeout(timer)
    void this.options.client.sendTyping({ conversationId: this.conversationId, isTyping: false }).catch(() => undefined)
    await this.clearSubscriptions(); this.listeners.clear()
  }

  private get typingTimeout(): number { return this.options.typingTimeoutMs ?? 3000 }
  private clearReactions(): void {
    clearTimeout(this.reactionTimer); this.reactionTimer = undefined
    this.reactionDirty.clear(); this.reactionEpoch.clear(); this.reactions.clear(); this.loadingReactions = false
  }
  private bind(generation: number): void {
    const client = this.options.client
    this.subscriptions.add(client.onMessage(this.conversationId, event => { void this.receive(event.message, event.type, generation) }))
    this.subscriptions.add(client.onMessageDeleted(this.conversationId, event => {
      if (!this.current(generation) || event.conversationId !== this.conversationId) return
      this.remove(event.id); this.emit()
    }))
    if (client.onReactionChanged) this.subscriptions.add(client.onReactionChanged(this.conversationId, event => {
      if (this.current(generation) && event.conversationId === this.conversationId) this.queueReactionRefresh([event.id])
    }))
    this.subscriptions.add(client.onReadReceipt(this.conversationId, event => {
      if (!this.current(generation)) return
      if (this.mergeRead(event.userId, event.readAt, event.readPosition)) this.emit()
    }))
    this.subscriptions.add(client.onTyping(this.conversationId, event => {
      if (!this.current(generation) || event.userId === client.currentUserId) return
      clearTimeout(this.remoteTypingTimers.get(event.userId))
      if (event.isTyping) {
        this.typing.add(event.userId)
        this.remoteTypingTimers.set(event.userId, setTimeout(() => {
          this.typing.delete(event.userId); this.remoteTypingTimers.delete(event.userId); this.emit()
        }, this.typingTimeout))
      } else { this.typing.delete(event.userId); this.remoteTypingTimers.delete(event.userId) }
      this.emit()
    }))
    this.subscriptions.add(client.onConnectionEvent(event => {
      if (!this.current(generation)) return
      if (event.status === 'SUBSCRIBED' &&
          (event.topic === `messages:${this.conversationId}` || event.topic === `conversation:${this.conversationId}`)) {
        // A rejoin may have missed a parent's edit, which no row-precedence rule can see from a reply
        // row: every non-terminal preview is re-read on the next batch.
        this.markPreviewsStale()
        this.queueReactionRefresh([...this.messages.keys()])
        this.queueRefresh()
      }
    }, () => this.retire(generation)))
    // `inbox_changed` (a title or membership change, a deletion whose `message_deleted` was missed) reconciles
    // the room like a rejoin does. The SDK also delivers it on every join, synchronously when the app hub is
    // already subscribed, so the signal is queued behind the load that is binding it.
    this.subscriptions.add(client.onInboxChanged(() => {
      if (!this.current(generation)) return
      this.queueRefresh()
    }))
  }
  /** Reconcile once the current load, reconcile or history page settles; one queued refresh covers every
   * signal received meanwhile (a rejoin, an `inbox_changed` burst).
   */
  private queueRefresh(): void {
    this.refreshQueued = true; this.windowRefreshQueued = true
    this.flushRefresh()
  }
  private flushRefresh(): void {
    if (!this.refreshQueued || this.disposed || !this.hasLoaded || this.initialLoading || this.loadingOlder || this.reconciling) return
    // While jumped the tail-anchored reconcile is replaced, not dropped: one bounded re-read of the
    // jumped window runs instead, and `refreshQueued` is deliberately left set so the owed reconcile
    // still flushes on the return to live. `windowRefreshQueued` keeps that owed flag from re-entering
    // this branch every time an operation settles.
    if (this.windowMode === 'jumped') {
      if (!this.windowRefreshQueued || this.loadingNewer || this.jumping) return
      this.windowRefreshQueued = false
      void this.refreshWindow()
      return
    }
    this.refreshQueued = false
    void this.refresh()
  }
  private async receive(row: Message, type: MessageEvent['type'], generation: number): Promise<void> {
    if (!this.current(generation) || row.conversationId !== this.conversationId || this.deleted.has(row.id)) return
    const known = this.messages.has(row.id) || this.deferred.has(row.id)
    let complete = row
    try { complete = await this.options.client.getMessage(row.id) }
    catch (error) {
      if (!this.current(generation)) return
      // A row the server no longer has is a deletion; any other failure keeps the authorized live row.
      if (isNotFound(error)) { this.remove(row.id); this.emit(); return }
    }
    if (!this.current(generation) || this.deleted.has(row.id)) return
    // A jumped window records inserts without rendering them: `messages` IS the rendered set, so a row
    // that is not already in the window waits in `deferred` until `returnToLatest()` drains it. Edits,
    // revisions and tombstones for rows inside the window still apply.
    const deferred = this.windowMode === 'jumped' && !this.messages.has(complete.id)
    if (deferred) { this.defer(complete) } else { this.store(complete) }
    if (complete.clientMessageId) {
      for (const candidate of this.messages.values()) {
        if (isConvoKitPendingMessage(candidate) && candidate.clientMessageId === complete.clientMessageId &&
            candidate.senderId === complete.senderId) this.messages.delete(candidate.id)
      }
    }
    this.emit()
    if (deferred) return
    if (type === 'insert') this.schedulePreviews(generation)
    else this.resolvePreviews()
    // Only a newly rendered foreign message is a read trigger; edits and echoes of known rows are not,
    // and neither is a deferred row — its acknowledgement waits until the drain renders it.
    if (type === 'insert' && !known && complete.senderId !== this.options.client.currentUserId &&
        this.options.markReadOnReceive !== false) void this.acknowledge()
  }
  private merge(rows: readonly Message[]): void {
    for (const row of rows) {
      if (row.conversationId !== this.conversationId || this.deleted.has(row.id)) continue
      this.store(row)
    }
  }
  /** Keep the newer of the known row and an incoming one (D11), then check the edit session against it. */
  private store(row: Message): void {
    const existing = this.messages.get(row.id)
    this.messages.set(row.id, existing ? newer(existing, row) : row); this.rendered = true
    // A parent that is rendered is its own preview: an edit response, an UPDATE image, a hydration or a
    // reconcile refreshes the quoted block here, because no row-precedence rule can carry a parent's
    // revision bump into the reply row that quotes it.
    if (this.previews.has(row.id)) {
      const current = this.messages.get(row.id)
      if (current) { this.previews.set(row.id, derivePreview(current)); this.stalePreviews.delete(row.id) }
    }
    this.detectConflict()
  }
  /** The local conflict: a row for the edited id with a higher revision than the snapshot (an UPDATE image,
   * a hydration, a reconcile) enters the same state as a 409 without a round trip. The snapshot is replaced
   * so the next save carries the fresh revision; the composer keeps its text and edit mode stays on. Not
   * while that row's own save is in flight: its images wait for the response (`saveEdit`).
   */
  private detectConflict(): void {
    const snapshot = this.editing
    if (!snapshot || snapshot.id === this.saving) return
    const row = this.messages.get(snapshot.id)
    if (row && usableRevision(row) && row.revision > snapshot.revision) { this.editing = row; this.error = conflictError() }
  }
  /** The 409 path: one `getMessage`; the row merges under the guards and becomes the new snapshot, `error`
   * carries the conflict. A reload that answers `MESSAGE_NOT_FOUND` removes the row and leaves edit mode;
   * another reload failure keeps the snapshot and surfaces that failure.
   */
  private async reloadConflict(id: string, conflict: unknown, generation: number): Promise<void> {
    try {
      const row = await this.options.client.getMessage(id)
      if (!this.current(generation) || this.deleted.has(id)) return
      if (row.id !== id || row.conversationId !== this.conversationId) throw new Error('Reloaded message does not match')
      this.store(row)
      if (this.editing?.id === id) this.editing = this.messages.get(id) ?? row
      this.error = conflict
    } catch (error) {
      if (!this.current(generation) || this.deleted.has(id)) return
      if (isTargetMiss(error)) this.remove(id)
      this.error = error
    }
  }
  /** Own, confirmed and not removed: the rows an author may edit or delete. */
  private editable(row: Message): boolean {
    return row.senderId === this.options.client.currentUserId && !isConvoKitPendingMessage(row) && !this.deleted.has(row.id)
  }
  /** The caller's role when the conversation reports it: the self-only `membership` (0.7 backend), else
   * the caller's own `participants` entry.
   */
  private role(): string | undefined {
    const me = this.options.client.currentUserId
    return this.conversation?.membership?.role ??
      this.conversation?.participants.find(row => row.appUserId === me || row.id === me)?.role
  }
  private remove(id: string): void {
    this.deleted.add(id); this.messages.delete(id); this.deferred.delete(id)
    if (this.editing?.id === id) this.editing = null
    // A quoted parent that is gone stays quoted: the reply keeps its reference and its jump affordance
    // and renders "Original message unavailable". This works for a parent outside the window too,
    // because the deletion event carries its id whether or not the row was ever rendered.
    if (this.previews.has(id) || this.referencedParents().has(id)) {
      this.previews.set(id, 'unavailable'); this.stalePreviews.delete(id)
    }
    if (this.replyTarget?.id === id) this.replyTarget = null
    // A removed acknowledgement target can never be confirmed; fall back to the next newest row once, but
    // only where that row's arrival would have been acknowledged anyway: a room that opted out of receive
    // acknowledgements never sends one because a deletion arrived (an explicit `markRead()` still does).
    const inFlight = this.inFlight?.id === id
    if (!inFlight && this.acknowledged?.id !== id) return
    this.unacknowledgeable.add(id)
    if (!inFlight) this.acknowledged = null
    if (this.options.markReadOnReceive === false) return
    if (this.acknowledging) this.followUp = true
    else void this.acknowledge()
  }
  private mergeParticipantReads(conversation: Conversation): void {
    for (const participant of conversation.participants) {
      this.mergeRead(participant.appUserId, participant.lastReadAt, participant.readPosition)
    }
  }
  /** Advance a user's read state monotonically: ack time by max, position by cursor order. */
  private mergeRead(userId: string, readAt: Date | null | undefined, readPosition: ReadPosition | null | undefined): boolean {
    if (!userId) return false
    let changed = false
    if (readAt && Number.isFinite(readAt.getTime())) {
      const previous = this.reads.get(userId)
      if (!previous || readAt.getTime() > previous.getTime()) { this.reads.set(userId, readAt); changed = true }
    }
    if (readPosition && Number.isFinite(readPosition.createdAt.getTime())) {
      const previous = this.positions.get(userId)
      if (!previous || !covers(previous, { id: readPosition.messageId, createdAt: readPosition.createdAt })) {
        this.positions.set(userId, readPosition); changed = true
      }
    }
    return changed
  }
  /** The newest rendered, confirmed message the server has not refused as a target. */
  private resolveTarget(): MessageCursor | null {
    const rows = sortMessages(this.messages.values())
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!
      if (!isConvoKitPendingMessage(row) && !this.unacknowledgeable.has(row.id)) return { id: row.id, createdAt: row.createdAt }
    }
    return null
  }
  private async acknowledge(): Promise<void> {
    if (this.disposed) return
    // No targeted acknowledgement while jumped, and none armed: the newest rendered row is not the room's
    // newest, and an acknowledgement carrying the version captured at open clears the caller's unread
    // marker whether or not the position advanced. The return to live acknowledges what it renders.
    if (this.windowMode === 'jumped') return
    if (!this.visible) { this.suppressed = true; return }
    if (this.acknowledging) { this.followUp = true; return }
    const generation = this.generation
    this.acknowledging = true
    try {
      do {
        this.followUp = false
        if (!this.visible) { this.suppressed = true; return }
        const target = this.resolveTarget()
        // Nothing rendered: the only request is the once-per-open clear of a marked room (D9); a row that
        // arrives meanwhile sets `followUp` and is acknowledged by the next turn of the loop.
        if (!target) { await this.clearMarker(generation); if (!this.current(generation)) return; continue }
        if (this.acknowledged && compareCursor(target, this.acknowledged) <= 0) return
        this.inFlight = target
        try {
          await this.options.client.markConversationRead(this.conversationId, {
            throughMessageId: target.id,
            ...(this.openedVersion === undefined ? {} : { privateStateVersion: this.openedVersion }),
          })
          if (!this.current(generation)) return
          if (!this.unacknowledgeable.has(target.id)) this.acknowledged = target
        } catch (error) {
          if (!this.current(generation)) return
          if (!isTargetMiss(error)) { this.error = error; this.emit(); return }
          this.unacknowledgeable.add(target.id); this.followUp = true
        } finally { if (this.inFlight === target) this.inFlight = null }
      } while (this.followUp)
    } finally { if (this.current(generation)) this.acknowledging = false }
  }
  private resetAcknowledgements(): void {
    this.acknowledging = false; this.followUp = false; this.suppressed = false
    this.inFlight = null; this.acknowledged = null; this.unacknowledgeable.clear()
    this.openedVersion = undefined; this.pendingClear = null; this.rendered = false
  }
  /** Capture the caller's private state for this open from the DTO's self-only `membership` (absent on a
   * 0.6 backend: acknowledgements then carry no version and nothing is ever cleared without one).
   */
  private capture(conversation: Conversation): void {
    const membership = conversation.membership
    this.openedVersion = membership?.privateStateVersion
    this.pendingClear = membership && membership.unreadMarkedAt !== null ? membership.privateStateVersion : null
  }
  /** An opened room that was marked unread and rendered nothing has no target to acknowledge, so it clears
   * the marker through the adapter instead, conditionally on the captured version and once per open; a
   * `cleared: false` answer (the marker moved on) is not an error, and adapters without the member keep it.
   */
  private async clearMarker(generation: number): Promise<void> {
    const version = this.pendingClear
    const clear = this.options.client.clearConversationUnread
    if (version === null || this.rendered || !clear) return
    this.pendingClear = null
    try { await clear.call(this.options.client, this.conversationId, { ifVersion: version }) }
    catch (error) { if (this.current(generation)) { this.error = error; this.emit() } }
  }
  private assertRows(rows: readonly Message[]): void {
    if (rows.length > Math.max(this.messagePageSize, this.messages.size, this.messagePageSize) ||
        rows.some(row => !row.id.trim() || row.conversationId !== this.conversationId)) throw new Error('Invalid message page')
  }
  /** Every field a jump owns, back to the live defaults. Called only where the whole per-room state
   * resets (`loadInitial`, `retire`), never on a jump.
   */
  private resetWindow(): void {
    this.clearPreviewTimer(); this.clearHighlightTimer()
    this.replyTarget = null; this.deferred.clear(); this.previews.clear(); this.stalePreviews.clear()
    this.resolvingPreviews = false; this.previewsQueued = false
    this.highlighted = null; this.windowMode = 'live'; this.windowPaged = false; this.jumpAnchorId = null
    this.olderCursor = null; this.newerCursor = null; this.hasNewer = false; this.loadingNewer = false
    this.jumping = false; this.windowRefreshQueued = false
  }
  /** One context request: exactly one selector, and a limit the caller owns (the page size for a jump or
   * a cursor page, the window's own size for the jumped reconcile).
   */
  private contextPage(
    selector: { messageId: string } | { olderCursor: string } | { newerCursor: string },
    limit: number = this.messagePageSize,
  ): Promise<MessageContextPage> {
    const context = this.options.client.getMessageContext
    if (typeof context !== 'function') throw unsupported('getMessageContext')
    return context.call(this.options.client, this.conversationId, { ...selector, limit })
  }
  /** Install exactly the rows a context response carried, filtered by the tombstones only: a window
   * replacement must not replay pending rows or recorded inserts, which belong to the live tail. Only
   * the rendered set changes — the edit session and the reply target are the caller's, not the window's,
   * and survive the replacement; a deletion is what ends them.
   */
  private replaceWindow(rows: readonly Message[]): void {
    const next = new Map<string, Message>()
    for (const row of rows) if (!this.deleted.has(row.id)) next.set(row.id, row)
    this.messages = next
    if (next.size) this.rendered = true
    this.detectConflict()
  }
  /** A context window is not a history page: it is bidirectional, carries its own cursors and may be
   * longer than `messagePageSize` would allow, so it gets its own validator rather than relaxing
   * `assertRows`. Room-scoped, distinct, confirmed, strictly newest-first and at most `limit` rows; a
   * centred fetch additionally carries its target exactly once, a cursor page never does.
   */
  private validateContextPage(page: MessageContextPage, limit: number, targetId?: string): void {
    const rows = page.messages
    const invalid = (): Error => new Error('Invalid message context window')
    if (rows.length > limit) throw invalid()
    const seen = new Set<string>()
    let previous: MessageCursor | null = null
    for (const row of rows) {
      if (!row.id.trim() || row.conversationId !== this.conversationId || isConvoKitPendingMessage(row)) throw invalid()
      if (seen.has(row.id)) throw invalid()
      seen.add(row.id)
      if (previous && compareCursor(row, previous) >= 0) throw invalid()
      previous = row
    }
    if (targetId !== undefined && !seen.has(targetId)) throw invalid()
  }
  /** A context request failed: a 0.8 backend's uncoded 404 surfaces once and then retires the affordance
   * for the life of the controller (the route does not exist and never will for this backend), so the
   * host learns why the affordance disappeared without the failure repeating — the flag is what makes it
   * once, since no second request is ever issued. Anything else is an ordinary error on the existing
   * surface, with the window left as it was. Only `getMessageContext` calls come here; an ordinary
   * `getMessages` 404 is a membership miss and never retires anything.
   */
  private recordWindowError(error: unknown): void {
    if (isMissingEndpoint(error)) {
      if (this.supportsJump) this.error = error
      this.supportsJump = false
      return
    }
    this.error = error
  }
  /** Record an insert a jumped window must not render yet, keeping the newer of the two under the same
   * precedence rule the rendered set uses.
   */
  private defer(row: Message): void {
    const existing = this.deferred.get(row.id)
    this.deferred.set(row.id, existing ? newer(existing, row) : row)
    // The row is a parent of a rendered reply that is outside the window: its cached preview is stale.
    if (this.previews.get(row.id) !== undefined && this.previews.get(row.id) !== 'unavailable') {
      this.stalePreviews.add(row.id)
    }
  }
  /** Render everything the jumped window recorded, and acknowledge it now that it is on screen. */
  private drainDeferred(): void {
    if (!this.deferred.size) return
    const rows = [...this.deferred.values()]
    this.deferred.clear()
    let arrived = false
    for (const row of rows) {
      if (this.deleted.has(row.id)) continue
      const known = this.messages.has(row.id)
      this.store(row)
      if (!known && row.senderId !== this.options.client.currentUserId) arrived = true
    }
    if (arrived && this.options.markReadOnReceive !== false) void this.acknowledge()
  }
  /** Put back what the failed return to live rendered: every row that joined the rendered set while the
   * store believed it was live (the drained rows and any insert during the reload) is recorded again, so
   * the restored window is exactly the one the jump installed.
   */
  private redefer(windowIds: ReadonlySet<string>): void {
    for (const [id, row] of [...this.messages]) {
      if (windowIds.has(id) || isConvoKitPendingMessage(row)) continue
      this.messages.delete(id)
      this.defer(row)
    }
  }
  /** The jumped window's reconcile: one bounded, centred re-read instead of the newest-N page, which is
   * anchored at the live tail and would never cover a window further back than the page cap. The anchor
   * is the jump target until the window is paged, then the window's midpoint; the limit is the window's
   * own size. Tombstones are bounded by the range the response returned, so rows outside it are kept.
   */
  private async refreshWindow(): Promise<void> {
    if (this.disposed || this.reconciling || typeof this.options.client.getMessageContext !== 'function') return
    const generation = this.generation
    const window = sortMessages(this.messages.values()).filter(row => !isConvoKitPendingMessage(row))
    const anchor = this.jumpAnchorId && !this.windowPaged && this.messages.has(this.jumpAnchorId)
      ? this.jumpAnchorId
      : window[Math.floor((window.length - 1) / 2)]?.id
    if (!anchor) return
    const limit = Math.min(Math.max(window.length, 1), maxMessageLimit)
    this.reconciling = true; this.emit()
    try {
      const [conversation, page] = await Promise.all([
        this.options.client.getConversation(this.conversationId),
        this.contextPage({ messageId: anchor }, limit),
      ])
      if (!this.current(generation)) return
      // The window went live while the re-read was in flight (a return to latest). Installing it would
      // re-inject historical rows into the live window and set `hasNewerMessages` from a historical
      // cursor, which `loadNewerMessages` refuses to clear in `live` — an unrecoverable state. The owed
      // tail reconcile (E5b) covers the live window instead, and the `finally` below flushes it.
      if (this.windowMode !== 'jumped') return
      this.validateContextPage(page, limit, anchor)
      const opening = this.conversation === null
      this.conversation = conversation
      if (opening) this.capture(conversation)
      const rows = page.messages
      const newestRow = rows[0] ?? null
      const oldestRow = rows[rows.length - 1] ?? null
      const returned = (row: Message): boolean => Boolean(newestRow && oldestRow &&
        compareCursor(row, oldestRow) >= 0 && compareCursor(row, newestRow) <= 0)
      // Each row still merges under precedence, so an in-flight edit response or a newer UPDATE image is
      // never rewound by a window fetched before it.
      const canonical = new Map<string, Message>()
      for (const row of rows) {
        if (this.deleted.has(row.id)) continue
        const existing = this.messages.get(row.id)
        canonical.set(row.id, existing ? newer(existing, row) : row)
      }
      for (const row of this.messages.values()) {
        if (canonical.has(row.id)) continue
        if (isConvoKitPendingMessage(row) || !returned(row)) canonical.set(row.id, row)
      }
      this.messages = canonical
      if (this.editing && !canonical.has(this.editing.id)) this.editing = null
      for (const row of window) {
        if (canonical.has(row.id) || this.deleted.has(row.id) || !returned(row)) continue
        this.remove(row.id)
      }
      this.olderCursor = page.olderCursor; this.newerCursor = page.newerCursor
      this.hasOlder = page.olderCursor !== null; this.hasNewer = page.newerCursor !== null
      this.mergeParticipantReads(conversation)
      this.error = null
      this.detectConflict()
    } catch (error) {
      if (!this.current(generation)) return
      // The anchor itself was deleted while the client was away: tombstone it like any deletion and
      // leave the rest of the window; the owed reconcile still runs on the return to live.
      if (isTargetMiss(error)) this.remove(anchor)
      else this.recordWindowError(error)
    } finally {
      if (this.current(generation)) { this.reconciling = false; this.emit(); this.flushRefresh(); this.resolvePreviews() }
    }
  }
  /** Mark the jumped-to row for ~2 seconds. The timer carries the generation it was scheduled with, so a
   * reload or a session change between the jump and the timeout emits nothing.
   */
  private highlight(id: string): void {
    this.clearHighlightTimer()
    this.highlighted = id
    const generation = this.generation
    const timer = setTimeout(() => {
      if (this.highlightTimer === timer) this.highlightTimer = undefined
      if (!this.current(generation) || this.highlighted !== id) return
      this.highlighted = null; this.emit()
    }, this.options.highlightDurationMs ?? 2000)
    ;(timer as { unref?: () => void }).unref?.()
    this.highlightTimer = timer
  }
  private clearHighlightTimer(): void {
    if (this.highlightTimer === undefined) return
    clearTimeout(this.highlightTimer); this.highlightTimer = undefined
  }
  /** The distinct quoted parents the rendered rows reference. */
  private referencedParents(): Set<string> {
    const ids = new Set<string>()
    for (const row of this.messages.values()) {
      if (row.replyToMessageId !== undefined) ids.add(row.replyToMessageId)
    }
    return ids
  }
  private markPreviewsStale(): void {
    for (const [id, entry] of this.previews) if (entry !== 'unavailable') this.stalePreviews.add(id)
  }
  /** Coalesce a burst of live inserts into one batch. The handle carries the generation captured when it
   * was scheduled and is cleared wherever the room's subscriptions are, so a burst followed by
   * `dispose()` issues no request and emits no state.
   */
  private schedulePreviews(generation: number): void {
    if (!this.current(generation) || this.previewTimer !== undefined) return
    const timer = setTimeout(() => {
      if (this.previewTimer === timer) this.previewTimer = undefined
      if (!this.current(generation)) return
      this.resolvePreviews()
    }, Math.max(this.options.replyPreviewWindowMs ?? 250, 0))
    ;(timer as { unref?: () => void }).unref?.()
    this.previewTimer = timer
  }
  private clearPreviewTimer(): void {
    if (this.previewTimer === undefined) return
    clearTimeout(this.previewTimer); this.previewTimer = undefined
  }
  /** Resolve the quoted parents of the rendered replies in ONE request, never one per row. A parent that
   * is itself in the window is derived locally and costs nothing; `'unavailable'` is terminal and is
   * never re-requested; an id with no entry is "not yet had", which is also what a failed batch leaves,
   * so the next trigger asks again. Entries no rendered row references are dropped, so the cache stays
   * bounded by the window.
   */
  private resolvePreviews(): void {
    const referenced = this.referencedParents()
    let changed = false
    for (const id of [...this.previews.keys()]) {
      if (referenced.has(id)) continue
      this.previews.delete(id); this.stalePreviews.delete(id); changed = true
    }
    const wanted: string[] = []
    for (const id of referenced) {
      const parent = this.messages.get(id)
      if (parent) {
        this.previews.set(id, derivePreview(parent)); this.stalePreviews.delete(id); changed = true
        continue
      }
      const cached = this.previews.get(id)
      if (cached === 'unavailable') continue
      if (cached !== undefined && !this.stalePreviews.has(id)) continue
      wanted.push(id)
    }
    if (changed) this.emit()
    if (!wanted.length || this.disposed) return
    const resolve = this.options.client.getReplyPreviews
    if (!this.supportsReplyPreviews || typeof resolve !== 'function') return
    if (this.resolvingPreviews) { this.previewsQueued = true; return }
    this.resolvingPreviews = true
    const generation = this.generation
    void (async () => {
      try {
        const previews = await resolve.call(this.options.client, this.conversationId, wanted)
        // The response applies through the same liveness guard as every other one, and is dropped rather
        // than patched into a store that has since reloaded or changed hands.
        if (!this.current(generation)) return
        const byId = new Map(previews.map(preview => [preview.id, preview]))
        for (const id of wanted) {
          // A batch that RESOLVED is the only deletion signal: an id missing from it is gone for good.
          this.previews.set(id, byId.get(id) ?? 'unavailable'); this.stalePreviews.delete(id)
        }
        this.emit()
      } catch (error) {
        if (!this.current(generation)) return
        // A rejection writes no entry for any id in the batch: those ids stay unresolved and are asked
        // for again on the next trigger, so a transient failure can never read as "parent deleted". A
        // 0.8 backend's uncoded 404 surfaces once and then retires the route for the life of the
        // controller, so quoted blocks degrade to the bare reference instead of failing repeatedly.
        if (isMissingEndpoint(error)) {
          if (this.supportsReplyPreviews) this.error = error
          this.supportsReplyPreviews = false
        } else this.error = error
        this.emit()
      } finally {
        if (this.current(generation)) {
          this.resolvingPreviews = false
          if (this.previewsQueued) { this.previewsQueued = false; this.resolvePreviews() }
        }
      }
    })()
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.sessionIdentity === this.options.client.sessionIdentity
  }
  private retire(generation: number): void {
    if (this.disposed || generation !== this.generation) return
    ++this.generation; this.messages.clear(); this.conversation = null; this.typing.clear(); this.reads.clear(); this.positions.clear()
    this.resetAcknowledgements(); this.editing = null; this.saving = null; this.refreshQueued = false
    this.clearReactions()
    this.resetWindow()
    this.error = new Error('ConvoKit session ended'); this.emit()
  }
  private async clearSubscriptions(): Promise<void> {
    await closeAll(this.subscriptions); this.subscriptions.clear()
  }
}
