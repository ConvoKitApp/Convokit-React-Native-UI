export abstract class ObservableStore<T> {
  protected listeners = new Set<() => void>()
  abstract getSnapshot(): T
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  protected emit(): void { for (const listener of [...this.listeners]) listener() }
}

export async function closeAll(values: Iterable<{ unsubscribe(): Promise<void> }>): Promise<void> {
  await Promise.all([...values].map(value => value.unsubscribe().catch(() => undefined)))
}
