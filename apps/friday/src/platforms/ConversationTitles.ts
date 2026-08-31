import type { ChannelThread, TaskId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Semaphore from 'effect/Semaphore'

import { PlatformRegistry } from './PlatformRegistry.ts'

export interface ConversationTitlesContract {
  readonly generated: (thread: ChannelThread, title: string) => Effect.Effect<void>
  readonly taskStarted: (
    thread: ChannelThread,
    taskId: TaskId,
    task?: string,
  ) => Effect.Effect<void>
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

    interface ConversationLock {
      readonly semaphore: Semaphore.Semaphore
      users: number
    }

    // Nested maps instead of a concatenated key so arbitrary connection/conversation
    // identifiers can never collide (e.g. ('a','b:c') vs ('a:b','c')).
    const locks = new Map<string, Map<string, ConversationLock>>()
    const serialized = <A>(thread: ChannelThread, effect: Effect.Effect<A>): Effect.Effect<A> =>
      Effect.suspend(() => {
        const binding = thread.conversationBinding
        const { connectionId, conversationId } = binding
        let conversations = locks.get(connectionId)
        if (conversations === undefined) {
          conversations = new Map()
          locks.set(connectionId, conversations)
        }
        const entry = conversations.get(conversationId) ?? {
          semaphore: Semaphore.makeUnsafe(1),
          users: 0,
        }
        conversations.set(conversationId, entry)
        entry.users += 1
        return entry.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.users -= 1
              if (entry.users === 0 && conversations.get(conversationId) === entry) {
                conversations.delete(conversationId)
                if (conversations.size === 0) locks.delete(connectionId)
              }
            }),
          ),
        )
      })

    const updateActivity = (
      thread: ChannelThread,
      taskId: TaskId,
      active: boolean,
      task?: string,
    ) =>
      serialized(
        thread,
        platforms
          .setAgentActivity(
            task === undefined
              ? { binding: thread.conversationBinding, taskId, active }
              : { binding: thread.conversationBinding, taskId, active, task },
          )
          .pipe(
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
        serialized(
          thread,
          platforms
            .setConversationTitle({ binding: thread.conversationBinding, title })
            .pipe(Effect.ignore),
        ),
      taskStarted: (thread, taskId, task) => updateActivity(thread, taskId, true, task),
      taskFinished: (thread, taskId) => updateActivity(thread, taskId, false),
    })
  }),
)
