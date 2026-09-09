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
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void ref.current?.refresh()
    })
    return () => { subscription.remove(); void ref.current?.dispose() }
  }, [])
  return { controller: ref.current, state: useControllerState(ref.current) }
}
