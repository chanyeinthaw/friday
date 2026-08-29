import type { ChannelThread, TaskId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Semaphore from 'effect/Semaphore'

import { PlatformRegistry } from './PlatformRegistry.ts'

export interface ConversationTitlesContract {
  readonly generated: (thread: ChannelThread, title: string) => Effect.Effect<void>
  readonly taskStarted: (thread: ChannelThread, taskId: TaskId) => Effect.Effect<void>
  readonly taskFinished: (thread: ChannelThread, taskId: TaskId) => Effect.Effect<void>
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
    const updateActivity = (thread: ChannelThread, taskId: TaskId, active: boolean) =>
      lock.withPermit(
        platforms.setAgentActivity({ binding: thread.conversationBinding, taskId, active }).pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              Effect.logWarning('platform.agent-activity.failed').pipe(
                Effect.annotateLogs({
                  platform: thread.conversationBinding.platform,
                  taskId,
                  active,
                  cause: String(cause),
                }),
              ),
            onSuccess: () => Effect.void,
          }),
        ),
      )

    return ConversationTitles.of({
      generated: (thread, title) =>
        platforms
          .setConversationTitle({ binding: thread.conversationBinding, title })
          .pipe(Effect.ignore),
      taskStarted: (thread, taskId) => updateActivity(thread, taskId, true),
      taskFinished: (thread, taskId) => updateActivity(thread, taskId, false),
    })
  }),
)
