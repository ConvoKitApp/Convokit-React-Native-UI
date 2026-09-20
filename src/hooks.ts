import { useEffect, useReducer, useRef } from 'react'
import { AppState } from 'react-native'
import { ConversationController, type ConversationControllerOptions, type ConversationState } from './conversation-controller'
import {
  ConversationListController,
  type ConversationListControllerOptions,
  type ConversationListState,
} from './conversation-list-controller'

export function useControllerState<T>(controller: { subscribe(listener: () => void): () => void; getSnapshot(): T }): T {
  const [, update] = useReducer(value => value + 1, 0)
  useEffect(() => controller.subscribe(update), [controller])
  return controller.getSnapshot()
}

/** Only a backgrounded or transitioning app is hidden; unknown states count as visible. */
const isVisible = (status: string | null | undefined): boolean => status !== 'background' && status !== 'inactive'

/** Report `AppState` visibility to a conversation controller so acknowledgements wait for the foreground. */
export function useConvoKitVisibility(controller: Pick<ConversationController, 'setVisible'>, onActive?: () => void): void {
  const active = useRef(onActive)
  active.current = onActive
  useEffect(() => {
    controller.setVisible(isVisible(AppState.currentState))
    const subscription = AppState.addEventListener('change', status => {
      controller.setVisible(isVisible(status))
      if (status === 'active') active.current?.()
    })
    return () => subscription.remove()
  }, [controller])
}

export function useConvoKitConversationList(
  options: ConversationListControllerOptions,
): { controller: ConversationListController; state: ConversationListState } {
  const ref = useRef<ConversationListController | null>(null)
  if (!ref.current) ref.current = new ConversationListController(options)
  useEffect(() => () => { void ref.current?.dispose() }, [])
  return { controller: ref.current, state: useControllerState(ref.current) }
}

export function useConvoKitConversation(
  options: ConversationControllerOptions,
): { controller: ConversationController; state: ConversationState } {
  const ref = useRef<ConversationController | null>(null)
  if (!ref.current) ref.current = new ConversationController(options)
  useConvoKitVisibility(ref.current, () => { void ref.current?.refresh() })
  useEffect(() => () => { void ref.current?.dispose() }, [])
  return { controller: ref.current, state: useControllerState(ref.current) }
}
