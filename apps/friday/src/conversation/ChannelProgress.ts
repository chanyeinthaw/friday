import type {
  ChannelThread,
  InputMessage,
  ThreadId,
  ToolCallId,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Semaphore from 'effect/Semaphore'

import type { ThreadRuntimeEvent } from './ThreadRuntime.ts'
import {
  PlatformNotFoundError,
  PlatformOperationError,
  PlatformRegistry,
} from '../platforms/PlatformRegistry.ts'

type ProgressError = PlatformNotFoundError | PlatformOperationError
type ToolCategory = 'commands' | 'editing' | 'reading' | 'task' | 'tools'

interface ChannelProgressState {
  readonly thread: ChannelThread
  readonly activeTools: Map<ToolCallId, ToolCategory>
  status: string
  activeTasks: number
}

export interface ChannelProgressContract {
  readonly accept: (
    thread: ChannelThread,
    message: InputMessage,
  ) => Effect.Effect<void, ProgressError>
  readonly observe: (
    threadId: ThreadId,
    event: ThreadRuntimeEvent,
  ) => Effect.Effect<void, ProgressError>
  readonly taskStarted: (thread: ChannelThread) => Effect.Effect<void, ProgressError>
  readonly taskFinished: (thread: ChannelThread) => Effect.Effect<void, ProgressError>
  readonly finalize: (thread: ChannelThread, text: string) => Effect.Effect<void, ProgressError>
}

export class ChannelProgress extends Context.Service<ChannelProgress, ChannelProgressContract>()(
  'friday/conversation/ChannelProgress',
) {}

const categoryFor = (toolName: string): ToolCategory => {
  switch (toolName) {
    case 'bash':
      return 'commands'
    case 'edit':
    case 'write':
      return 'editing'
    case 'read':
      return 'reading'
    case 'task':
      return 'task'
    default:
      return 'tools'
  }
}

const categoryText = (category: ToolCategory): string => {
  switch (category) {
    case 'commands':
      return 'Running commands...'
    case 'editing':
      return 'Editing files...'
    case 'reading':
      return 'Reading files...'
    case 'task':
      return 'Delegating task...'
    case 'tools':
      return 'Running tools...'
  }
}

const combinedText = (categories: ReadonlySet<ToolCategory>): string => {
  if (categories.size === 0) return 'Thinking...'
  if (categories.size === 1) return categoryText(Array.from(categories)[0] ?? 'tools')
  if (categories.size > 2 || categories.has('tools') || categories.has('task')) {
    return 'Running tools...'
  }
  if (categories.has('reading') && categories.has('commands')) {
    return 'Reading files and running commands...'
  }
  if (categories.has('reading') && categories.has('editing')) {
    return 'Reading and editing files...'
  }
  if (categories.has('editing') && categories.has('commands')) {
    return 'Editing files and running commands...'
  }
  return 'Running tools...'
}

const render = (status: string): string => `-# ${status}`

export const ChannelProgressLive = Layer.effect(
  ChannelProgress,
  Effect.gen(function* () {
    const platforms = yield* PlatformRegistry
    const lock = yield* Semaphore.make(1)
    const states = new Map<ThreadId, ChannelProgressState>()

    // Working-message decoration is best-effort; it must never fail the turn.
    const attempt = (operation: string, effect: Effect.Effect<void, ProgressError>) =>
      effect.pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.logWarning('progress.operation-failed').pipe(
              Effect.annotateLogs({ operation, cause: String(cause) }),
              Effect.as(false),
            ),
          onSuccess: () => Effect.succeed(true),
        }),
      )

    const update = (state: ChannelProgressState, status: string) => {
      if (state.status === status) return Effect.void
      return attempt(
        'update-working',
        platforms.updateWorking({
          binding: state.thread.conversationBinding,
          text: render(status),
        }),
      ).pipe(
        Effect.tap((published) =>
          published ? Effect.sync(() => void (state.status = status)) : Effect.void,
        ),
        Effect.asVoid,
      )
    }

    return ChannelProgress.of({
      accept: (thread, message) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (message.platformMessageId !== undefined) {
              yield* attempt(
                'acknowledge',
                platforms.acknowledge({
                  binding: thread.conversationBinding,
                  messageId: message.platformMessageId,
                }),
              )
            }
            const existing = states.get(thread.id)
            if (existing) return
            yield* attempt(
              'begin-working',
              platforms.beginWorking({
                binding: thread.conversationBinding,
                text: render('Thinking...'),
              }),
            )
            states.set(thread.id, {
              thread,
              activeTools: new Map(),
              status: 'Thinking...',
              activeTasks: 0,
            })
          }),
        ),
      observe: (threadId, event) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = states.get(threadId)
            if (!state) return
            if (event.type === 'turn-started') {
              yield* update(state, 'Thinking...')
              return
            }
            if (event.type === 'activity-completed' && event.activity.type === 'tool-call') {
              state.activeTools.set(event.activity.callId, categoryFor(event.activity.toolName))
              yield* update(state, combinedText(new Set(state.activeTools.values())))
              return
            }
            if (event.type === 'activity-completed' && event.activity.type === 'tool-result') {
              state.activeTools.delete(event.activity.callId)
              yield* update(state, combinedText(new Set(state.activeTools.values())))
            }
          }),
        ),
      taskStarted: (thread) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = states.get(thread.id)
            if (!state) return
            state.activeTasks += 1
            state.activeTools.clear()
            yield* update(state, 'Task delegated, waiting...')
          }),
        ),
      taskFinished: (thread) =>
        lock.withPermit(
          Effect.sync(() => {
            const state = states.get(thread.id)
            if (state) state.activeTasks = Math.max(0, state.activeTasks - 1)
          }),
        ),
      finalize: (thread, text) =>
        lock.withPermit(
          Effect.gen(function* () {
            const state = states.get(thread.id)
            if (state?.activeTasks) {
              const waitingText = render('Task delegated, waiting...')
              const published = yield* attempt(
                'publish-while-working',
                platforms.publishWhileWorking({
                  binding: thread.conversationBinding,
                  text,
                  workingText: waitingText,
                }),
              )
              if (published) state.status = 'Task delegated, waiting...'
              return
            }
            states.delete(thread.id)
            const finalized = yield* attempt(
              'finalize-working',
              platforms.finalizeWorking({ binding: thread.conversationBinding, text }),
            )
            if (!finalized) {
              yield* attempt(
                'publish-fallback',
                platforms.publish({ binding: thread.conversationBinding, text }),
              )
            }
          }),
        ),
    })
  }),
)
