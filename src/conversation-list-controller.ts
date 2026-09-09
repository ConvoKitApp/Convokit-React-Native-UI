import type { Conversation, RealtimeSubscription } from '@convokitapp/react-native'
import type { ConvoKitUiClient } from './client'
import { filterConversations, type ConversationFilter, type ConversationPageLoader } from './filter'
import { closeAll, ObservableStore } from './store'

export interface ConversationListState {
  conversations: readonly Conversation[]
  filter: ConversationFilter
  isInitialLoading: boolean
  isLoadingMore: boolean
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
}

export class ConversationListController extends ObservableStore<ConversationListState> {
  readonly pageSize: number
  private source: Conversation[] = []
  private filter: ConversationFilter
  private offset = 0
  private generation = 0
  private loadingInitial = false
  private loadingMore = false
  private hasMore = true
  private hasLoaded = false
  private error: unknown = null
  private subscriptions = new Set<RealtimeSubscription>()
  private disposed = false
  private refreshQueued = false
  private sessionIdentity: object | null = null

  constructor(private options: ConversationListControllerOptions) {
    super()
    this.pageSize = options.pageSize ?? 30
    if (this.pageSize < 1 || this.pageSize > 100) throw new RangeError('pageSize must be between 1 and 100')
    this.filter = options.initialFilter ?? {}
    if (options.autoLoad !== false) void this.loadInitial()
  }

  getSnapshot = (): ConversationListState => ({
    conversations: filterConversations(this.source, this.filter), filter: this.filter,
    isInitialLoading: this.loadingInitial, isLoadingMore: this.loadingMore,
    hasMore: this.hasMore, hasLoaded: this.hasLoaded, error: this.error,
  })

  async loadInitial(): Promise<void> {
    if (this.disposed) return
    const generation = ++this.generation
    await closeAll(this.subscriptions); this.subscriptions.clear()
    this.source = []; this.offset = 0; this.hasMore = true; this.error = null
    this.loadingInitial = true; this.emit()
    const identity = this.options.client.sessionIdentity
    this.sessionIdentity = identity
    try {
      if (!identity && !this.options.pageLoader) throw new Error('Connect a ConvoKit user before loading conversations')
      if (identity) {
        this.subscriptions.add(this.options.client.onConnectionEvent(() => {
          if (identity !== this.options.client.sessionIdentity) this.retire(generation)
        }, () => this.retire(generation)))
        this.subscriptions.add(this.options.client.onInboxChanged(() => this.queueRefresh(generation)))
      }
      await this.loadUntilVisible(generation)
    } catch (error) { if (this.current(generation)) this.error = error }
    finally {
      if (this.current(generation)) { this.loadingInitial = false; this.hasLoaded = true; this.emit() }
    }
  }

  async refresh(): Promise<void> {
    if (this.loadingInitial || this.loadingMore || this.disposed) { this.refreshQueued = true; return }
    const generation = this.generation
    const target = Math.max(this.offset, this.pageSize)
    const rows: Conversation[] = []
    let offset = 0
    try {
      while (offset < target) {
        const page = await this.page(offset)
        if (!this.current(generation)) return
        this.validate(page, new Set(rows.map(row => row.id)))
        rows.push(...page.filter(row => !rows.some(existing => existing.id === row.id)))
        offset += page.length
        if (page.length < this.pageSize) break
      }
      this.source = rows; this.offset = offset; this.hasMore = offset >= target && rows.length >= this.pageSize
      this.error = null; this.emit()
    } catch (error) { if (this.current(generation)) { this.error = error; this.emit() } }
    finally { this.refreshQueued = false }
  }

  async loadMore(): Promise<void> {
    if (this.disposed || this.loadingInitial || this.loadingMore || !this.hasMore) return
    const generation = this.generation; this.loadingMore = true; this.error = null; this.emit()
    try { await this.loadUntilVisible(generation) }
    catch (error) { if (this.current(generation)) this.error = error }
    finally { if (this.current(generation)) { this.loadingMore = false; this.emit() } }
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
    await closeAll(this.subscriptions); this.subscriptions.clear(); this.listeners.clear()
  }

  private async loadUntilVisible(generation: number): Promise<void> {
    const before = filterConversations(this.source, this.filter).length
    do {
      const page = await this.page(this.offset)
      if (!this.current(generation)) return
      this.validate(page, new Set(this.source.map(row => row.id)))
      this.offset += page.length; this.hasMore = page.length === this.pageSize
      const byId = new Map(this.source.map(row => [row.id, row]))
      for (const row of page) byId.set(row.id, row)
      this.source = [...byId.values()]; this.emit()
    } while (this.hasMore && filterConversations(this.source, this.filter).length === before)
  }
  private page(offset: number): Promise<Conversation[]> {
    return this.options.pageLoader?.({ limit: this.pageSize, offset, filter: this.filter }) ??
      this.options.client.getConversations({
        limit: this.pageSize, offset, archived: this.filter.archived ?? false,
      })
  }
  private validate(page: Conversation[], known: Set<string>): void {
    if (page.length > this.pageSize || page.some(row => !row.id.trim())) throw new Error('Invalid conversation page')
    if (page.length === this.pageSize && page.every(row => known.has(row.id))) {
      throw new Error('Conversation pagination did not advance')
    }
  }
  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation &&
      (Boolean(this.options.pageLoader) || this.sessionIdentity === this.options.client.sessionIdentity)
  }
  private retire(generation: number): void {
    if (this.disposed || generation !== this.generation) return
    ++this.generation; this.source = []; this.hasMore = false; this.error = new Error('ConvoKit session ended'); this.emit()
  }
  private queueRefresh(generation: number): void {
    if (!this.current(generation)) return
    this.refreshQueued = true
    queueMicrotask(() => { if (this.refreshQueued && this.current(generation)) void this.refresh() })
  }
}
