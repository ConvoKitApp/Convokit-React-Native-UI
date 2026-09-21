import type { Conversation, InboxPage, InboxSummary, RealtimeSubscription } from '@convokitapp/react-native'
import type { ConvoKitUiClient } from './client'
import { filterConversations, type ConversationFilter, type ConversationPageLoader } from './filter'
import { mergeInboxEntries } from './inbox'
import { closeAll, ObservableStore } from './store'

export interface ConversationListState {
  conversations: readonly Conversation[]
  /** Preview, unread count and read state per conversation id; empty on the legacy path. */
  summaries: ReadonlyMap<string, InboxSummary>
  /** The bound user on the inbox path; `''` without a session, on the legacy path and after dispose. */
  currentUserId: string
  filter: ConversationFilter
  isInitialLoading: boolean
  isLoadingMore: boolean
  isRefreshing: boolean
  hasMore: boolean
  hasLoaded: boolean
  error: unknown
}

export interface ConversationListControllerOptions {
  client: ConvoKitUiClient
  pageLoader?: ConversationPageLoader
  initialFilter?: ConversationFilter
  pageSize?: number
  autoLoad?: boolean
  /** Max wait before an `inbox_activity` signal refreshes the list; default 500, 0 refreshes immediately. */
  activityRefreshWindowMs?: number
}

const noSummaries: ReadonlyMap<string, InboxSummary> = new Map()
const inboxRefreshLimit = 100

function errorField(error: unknown, field: 'code' | 'status'): unknown {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[field] : undefined
}
const isNotFound = (error: unknown): boolean => errorField(error, 'status') === 404
/** The caller is no longer allowed to see the list (401/403) or the endpoint has no rows for them (404). */
const isDenial = (error: unknown): boolean => {
  const status = errorField(error, 'status')
  return status === 401 || status === 403 || status === 404
}

export class ConversationListController extends ObservableStore<ConversationListState> {
  readonly pageSize: number
  private source: Conversation[] = []
  private summaries: ReadonlyMap<string, InboxSummary> = noSummaries
  private filter: ConversationFilter
  private offset = 0
  private cursor: string | null = null
  private generation = 0
  private loadingInitial = false
  private loadingMore = false
  private refreshing = false
  private hasMore = true
  private hasLoaded = false
  private error: unknown = null
  private subscriptions = new Set<RealtimeSubscription>()
  private disposed = false
  private refreshQueued = false
  private loadMoreQueued = false
  private sessionIdentity: object | null = null
  private retired = false
  private boundUserId = ''
  private inboxUnavailable = false
  private warnedUnavailable = false
  private activityTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private options: ConversationListControllerOptions) {
    super()
    this.pageSize = options.pageSize ?? 30
    if (this.pageSize < 1 || this.pageSize > 100) throw new RangeError('pageSize must be between 1 and 100')
    this.filter = options.initialFilter ?? {}
    if (options.autoLoad !== false) void this.loadInitial()
  }

  getSnapshot = (): ConversationListState => ({
    conversations: filterConversations(this.source, this.filter), summaries: this.summaries,
    currentUserId: this.inboxMode && !this.disposed ? this.boundUserId : '', filter: this.filter,
    isInitialLoading: this.loadingInitial, isLoadingMore: this.loadingMore, isRefreshing: this.refreshing,
    hasMore: this.hasMore, hasLoaded: this.hasLoaded, error: this.error,
  })

  async loadInitial(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    this.clearActivityTimer()
    // The new generation owns the flags; in-flight operations of older generations never reset them.
    this.loadingMore = false; this.refreshing = false; this.refreshQueued = false; this.loadMoreQueued = false
    await closeAll(this.subscriptions); this.subscriptions.clear()
    this.source = []; this.summaries = noSummaries; this.offset = 0; this.cursor = null; this.hasMore = true
    this.error = null; this.inboxUnavailable = false; this.retired = false
    this.loadingInitial = true; this.emit()
    const identity = this.options.client.sessionIdentity
    this.sessionIdentity = identity
    this.boundUserId = identity ? this.options.client.currentUserId : ''
    try {
      if (!identity && !this.options.pageLoader) throw new Error('Connect a ConvoKit user before loading conversations')
      if (identity) {
        this.subscriptions.add(this.options.client.onConnectionEvent(() => {
          if (identity !== this.options.client.sessionIdentity) this.retire(generation)
        }, () => this.retire(generation)))
        this.subscriptions.add(this.options.client.onInboxChanged(() => {
          this.clearActivityTimer(); this.queueRefresh(generation)
        }))
        if (this.inboxMode && this.options.client.onInboxActivity) {
          this.subscriptions.add(this.options.client.onInboxActivity(() => this.scheduleActivityRefresh(generation)))
        }
      }
      await this.loadUntilVisible(generation)
    } catch (error) { this.fail(error, generation) }
    finally {
      if (this.current(generation)) { this.loadingInitial = false; this.hasLoaded = true; this.emit() }
      this.flushQueued()
    }
  }

  /** Reconcile the loaded window from the head. One walk runs at a time; a call during any load runs afterwards.
   * A walk covers every activity signal received so far, so a pending activity window is dropped.
   */
  async refresh(): Promise<void> {
    if (this.disposed || !this.current(this.generation)) return
    if (this.loadingInitial || this.loadingMore || this.refreshing) { this.refreshQueued = true; return }
    this.clearActivityTimer()
    const generation = this.generation
    this.refreshing = true; this.refreshQueued = false; this.emit()
    try {
      const reconciled = this.inboxMode ? await this.refreshInbox(generation) : false
      if (!this.current(generation)) return
      if (!reconciled) await this.refreshLegacy(generation)
      if (this.current(generation)) { this.error = null; this.emit() }
    } catch (error) { if (this.current(generation)) { this.fail(error, generation); this.emit() } }
    finally {
      if (this.current(generation)) { this.refreshing = false; this.emit() }
      this.flushQueued()
    }
  }

  async loadMore(): Promise<void> {
    if (this.disposed || this.loadingInitial || this.loadingMore || !this.hasMore) return
    if (this.refreshing) { this.loadMoreQueued = true; return }
    const generation = this.generation; this.loadingMore = true; this.error = null; this.emit()
    try { await this.loadUntilVisible(generation) }
    catch (error) { this.fail(error, generation) }
    finally {
      if (this.current(generation)) { this.loadingMore = false; this.emit() }
      this.flushQueued()
    }
  }

  async setFilter(filter: ConversationFilter): Promise<void> {
    const reload = filter.archived !== this.filter.archived || Boolean(this.options.pageLoader)
    this.filter = filter; this.error = null; this.emit()
    if (reload || !this.hasLoaded) await this.loadInitial()
    else if (!this.getSnapshot().conversations.length && this.hasMore) await this.loadMore()
  }
  setQuery(query: string): Promise<void> { return this.setFilter({ ...this.filter, query }) }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; ++this.generation
    this.clearActivityTimer(); this.refreshQueued = false; this.loadMoreQueued = false; this.boundUserId = ''
    await closeAll(this.subscriptions); this.subscriptions.clear(); this.listeners.clear()
  }

  /** Inbox mode: the adapter exposes `listInbox`, no custom page loader, and the endpoint has not 404ed. */
  private get inboxMode(): boolean {
    return Boolean(this.options.client.listInbox) && !this.options.pageLoader && !this.inboxUnavailable
  }
  private visible(): Conversation[] { return filterConversations(this.source, this.filter) }

  private async loadUntilVisible(generation: number): Promise<void> {
    const before = this.visible().length
    do {
      const advanced = this.inboxMode ? await this.loadInboxStep(generation) : await this.loadLegacyStep(generation)
      if (!this.current(generation)) return
      if (advanced) this.emit()
    } while (this.hasMore && this.visible().length === before)
  }
  /** One cursor page merged in; false when the endpoint fell back mid-operation (the step is re-run through the legacy path). */
  private async loadInboxStep(generation: number): Promise<boolean> {
    const requested = this.cursor
    const page = await this.fetchInbox(requested, this.pageSize, generation)
    if (!this.current(generation) || !page) return false
    this.validateInbox(page, requested, this.pageSize)
    const merged = mergeInboxEntries(this.source, this.summaries, page.entries)
    this.source = merged.conversations; this.summaries = merged.summaries
    this.cursor = page.nextCursor; this.hasMore = page.nextCursor !== null
    return true
  }
  private async loadLegacyStep(generation: number): Promise<boolean> {
    const page = await this.page(this.offset)
    if (!this.current(generation)) return false
    this.validate(page, new Set(this.source.map(row => row.id)))
    this.offset += page.length; this.hasMore = page.length === this.pageSize
    const byId = new Map(this.source.map(row => [row.id, row]))
    for (const row of page) byId.set(row.id, row)
    this.source = [...byId.values()]
    return true
  }

  /** Walk from the head until the loaded window is covered and something is visible, then swap atomically. */
  private async refreshInbox(generation: number): Promise<boolean> {
    const target = Math.max(this.pageSize, this.source.length)
    let rows: Conversation[] = []
    let summaries: ReadonlyMap<string, InboxSummary> = noSummaries
    let cursor: string | null = null
    let consumed = 0
    for (;;) {
      // Past the target only a fully hidden window keeps the walk going, one page at a time.
      const limit = consumed < target ? Math.min(inboxRefreshLimit, target - consumed) : this.pageSize
      const page = await this.fetchInbox(cursor, limit, generation)
      if (!this.current(generation)) return true
      if (!page) return false
      this.validateInbox(page, cursor, limit)
      ;({ conversations: rows, summaries } = mergeInboxEntries(rows, summaries, page.entries))
      consumed += page.entries.length
      cursor = page.nextCursor
      if (cursor === null || (consumed >= target && filterConversations(rows, this.filter).length > 0)) break
    }
    this.source = rows; this.summaries = summaries; this.cursor = cursor; this.hasMore = cursor !== null
    return true
  }
  private async refreshLegacy(generation: number): Promise<void> {
    const target = Math.max(this.offset, this.pageSize)
    const rows: Conversation[] = []
    let offset = 0
    while (offset < target) {
      const page = await this.page(offset)
      if (!this.current(generation)) return
      this.validate(page, new Set(rows.map(row => row.id)))
      rows.push(...page.filter(row => !rows.some(existing => existing.id === row.id)))
      offset += page.length
      if (page.length < this.pageSize) break
    }
    this.source = rows; this.summaries = noSummaries; this.offset = offset
    this.hasMore = offset >= target && rows.length >= this.pageSize
  }

  /** A 404 means the inbox route is absent (rollback/staging): stay on `getConversations` for this store. */
  private async fetchInbox(cursor: string | null, limit: number, generation: number): Promise<InboxPage | null> {
    try {
      return await this.options.client.listInbox!({ limit, cursor, archived: this.filter.archived ?? false })
    } catch (error) {
      if (!this.current(generation) || !isNotFound(error)) throw error
      this.inboxUnavailable = true; this.summaries = noSummaries; this.cursor = null; this.offset = this.source.length
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true
        console.warn('ConvoKit: the inbox endpoint is unavailable (404); listing conversations without previews or unread counts')
      }
      return null
    }
  }
  private page(offset: number): Promise<Conversation[]> {
    return this.options.pageLoader?.({ limit: this.pageSize, offset, filter: this.filter }) ??
      this.options.client.getConversations({
        limit: this.pageSize, offset, archived: this.filter.archived ?? false,
      })
  }
  /** Shape checks shared by both paths, plus the offset-only "no new ids" rule. */
  private validate(page: Conversation[], known: Set<string>): void {
    if (page.length > this.pageSize || page.some(row => !row.id.trim())) throw new Error('Invalid conversation page')
    if (page.length === this.pageSize && page.every(row => known.has(row.id))) {
      throw new Error('Conversation pagination did not advance')
    }
  }
  /** Cursor pages may legitimately repeat loaded ids (rooms fall below the cursor); only the cursor must advance. */
  private validateInbox(page: InboxPage, requested: string | null, limit: number): void {
    const ids = page.entries.map(entry => entry.conversation.id)
    if (page.entries.length > limit || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) {
      throw new Error('Invalid inbox page')
    }
    if (page.nextCursor !== null && (page.nextCursor === requested || !page.entries.length)) {
      throw new Error('Inbox pagination did not advance')
    }
  }
  /** Denials evict the rows (401/403 from either endpoint, 404 from the legacy one); anything else keeps them. */
  private fail(error: unknown, generation: number): void {
    if (!this.current(generation)) return
    if (isDenial(error)) {
      this.source = []; this.summaries = noSummaries; this.offset = 0; this.cursor = null; this.hasMore = false
    }
    this.error = error
  }
  private current(generation: number): boolean {
    return !this.disposed && !this.retired && generation === this.generation &&
      (Boolean(this.options.pageLoader) || this.sessionIdentity === this.options.client.sessionIdentity)
  }
  /** The session ended or changed hands: clear the rows and stay inert until the next `loadInitial()`. */
  private retire(generation: number): void {
    if (this.disposed || generation !== this.generation) return
    ++this.generation; this.retired = true; this.clearActivityTimer()
    this.loadingInitial = false; this.loadingMore = false; this.refreshing = false
    this.refreshQueued = false; this.loadMoreQueued = false; this.boundUserId = ''
    this.source = []; this.summaries = noSummaries; this.cursor = null; this.offset = 0; this.hasMore = false
    this.error = new Error('ConvoKit session ended'); this.emit()
  }
  private queueRefresh(generation: number): void {
    if (!this.current(generation)) return
    this.refreshQueued = true
    queueMicrotask(() => { if (this.refreshQueued && this.current(generation)) this.flushQueued() })
  }
  /** Run whatever was requested while an operation was in flight; called from every finally. */
  private flushQueued(): void {
    if (this.disposed || this.loadingInitial || this.loadingMore || this.refreshing) return
    if (this.refreshQueued) { this.refreshQueued = false; void this.refresh(); return }
    if (this.loadMoreQueued) { this.loadMoreQueued = false; void this.loadMore() }
  }
  /** Max-wait coalescing: the first signal starts the window, later ones ride along, the timer fires one refresh. */
  private scheduleActivityRefresh(generation: number): void {
    if (!this.current(generation) || !this.inboxMode) return
    const wait = this.options.activityRefreshWindowMs ?? 500
    if (wait <= 0) { this.queueRefresh(generation); return }
    if (this.activityTimer !== undefined) return
    const timer = setTimeout(() => {
      if (this.activityTimer === timer) this.activityTimer = undefined
      this.queueRefresh(generation)
    }, wait)
    ;(timer as { unref?: () => void }).unref?.()
    this.activityTimer = timer
  }
  private clearActivityTimer(): void {
    if (this.activityTimer === undefined) return
    clearTimeout(this.activityTimer); this.activityTimer = undefined
  }
}
