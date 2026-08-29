import type { ChannelThread, ConversationBinding, ThreadId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Semaphore from 'effect/Semaphore'

import { PlatformRegistry } from './PlatformRegistry.ts'

interface TitleState {
  readonly binding: ConversationBinding
  base: string | null
  activeTasks: number
}

export interface ConversationTitlesContract {
  readonly generated: (thread: ChannelThread, title: string) => Effect.Effect<void>
  readonly taskStarted: (thread: ChannelThread) => Effect.Effect<void>
  readonly taskFinished: (thread: ChannelThread) => Effect.Effect<void>
}

export class ConversationTitles extends Context.Service<
  ConversationTitles,
  ConversationTitlesContract
>()('friday/platforms/ConversationTitles') {}

const suffix = (count: number): string => (count === 1 ? ' ⚡️' : ` ⚡️x${count}`)
const stripSuffix = (title: string): string => title.replace(/ ⚡️(?:x\d+)?$/u, '').trimEnd()

export const ConversationTitlesLive = Layer.effect(
  ConversationTitles,
  Effect.gen(function* () {
    const platforms = yield* PlatformRegistry
    const lock = yield* Semaphore.make(1)
    const states = new Map<ThreadId, TitleState>()

    const stateFor = (thread: ChannelThread): TitleState => {
      const state = states.get(thread.id) ?? {
        binding: thread.conversationBinding,
        base: null,
        activeTasks: 0,
      }
      states.set(thread.id, state)
      return state
    }
    const publish = (state: TitleState) =>
      state.base === null
        ? Effect.void
        : platforms
            .setConversationTitle({
              binding: state.binding,
              title: `${state.base}${state.activeTasks > 0 ? suffix(state.activeTasks) : ''}`,
            })
            .pipe(Effect.ignore)

    return ConversationTitles.of({
      generated: (thread, title) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = stateFor(thread)
            state.base = stripSuffix(title)
            yield* publish(state)
          }),
        ),
      taskStarted: (thread) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = stateFor(thread)
            state.activeTasks += 1
            yield* publish(state)
          }),
        ),
      taskFinished: (thread) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = stateFor(thread)
            state.activeTasks = Math.max(0, state.activeTasks - 1)
            yield* publish(state)
          }),
        ),
    })
  }),
)
