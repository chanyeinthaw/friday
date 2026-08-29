import type { ChannelThread } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Semaphore from 'effect/Semaphore'

import { PlatformRegistry } from './PlatformRegistry.ts'

export interface ConversationTitlesContract {
  readonly generated: (thread: ChannelThread, title: string) => Effect.Effect<void>
  readonly taskStarted: (thread: ChannelThread) => Effect.Effect<void>
  readonly taskFinished: (thread: ChannelThread) => Effect.Effect<void>
}

export class ConversationTitles extends Context.Service<
  ConversationTitles,
  ConversationTitlesContract
>()('friday/platforms/ConversationTitles') {}

export const ConversationTitlesLive = Layer.effect(
  ConversationTitles,
  Effect.gen(function* () {
    const platforms = yield* PlatformRegistry
    const lock = yield* Semaphore.make(1)
    const activeTasks = new Map<string, number>()

    const updateActivity = (thread: ChannelThread, delta: 1 | -1) =>
      lock.withPermit(
        Effect.gen(function* () {
          const platform = thread.conversationBinding.platform
          const count = Math.max(0, (activeTasks.get(platform) ?? 0) + delta)
          activeTasks.set(platform, count)
          yield* platforms
            .setAgentActivity({ binding: thread.conversationBinding, activeTaskCount: count })
            .pipe(Effect.ignore)
        }),
      )

    return ConversationTitles.of({
      generated: (thread, title) =>
        platforms
          .setConversationTitle({ binding: thread.conversationBinding, title })
          .pipe(Effect.ignore),
      taskStarted: (thread) => updateActivity(thread, 1),
      taskFinished: (thread) => updateActivity(thread, -1),
    })
  }),
)
