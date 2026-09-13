import type {
  ChannelThread,
  InputMessage,
  ThreadId,
  ToolCallId,
  TurnId,
} from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
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
  readonly turnId: TurnId
  readonly activeTools: Map<ToolCallId, ToolCategory>
  status: string
}

export interface ChannelProgressContract {
  readonly accept: (
    thread: ChannelThread,
    message: InputMessage,
    turnId: TurnId,
  ) => Effect.Effect<void, ProgressError>
  readonly observe: (
    threadId: ThreadId,
    event: ThreadRuntimeEvent,
  ) => Effect.Effect<void, ProgressError>
  readonly finalize: (
    thread: ChannelThread,
    turnId: TurnId,
    text: string,
  ) => Effect.Effect<void, ProgressError>
}

export class ChannelProgress extends Context.Service<ChannelProgress, ChannelProgressContract>()(
  'friday/conversation/ChannelProgress',
) {}

export interface ChannelProgressOptions {
  readonly operationTimeout?: Duration.Input
}

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

// Statuses stay plain here. Discord renders subtext and Slack keeps the
// text unchanged, so each adapter formats at its own boundary.

export const makeChannelProgressLive = (options: ChannelProgressOptions = {}) =>
  Layer.effect(
    ChannelProgress,
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry
      const locks = new Map<ThreadId, Semaphore.Semaphore>()
      const lockFor = (threadId: ThreadId) => {
        const existing = locks.get(threadId)
        if (existing) return existing
        const created = Semaphore.makeUnsafe(1)
        locks.set(threadId, created)
        return created
      }
      const states = new Map<ThreadId, ChannelProgressState>()
      const operationTimeout = options.operationTimeout ?? '5 seconds'

      // Working-message decoration is best-effort and bounded; it must never block a turn.
      const attempt = (operation: string, effect: Effect.Effect<void, ProgressError>) =>
        effect.pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: operationTimeout,
            orElse: () =>
              Effect.logWarning('progress.operation-timed-out').pipe(
                Effect.annotateLogs({ operation }),
                Effect.as(false),
              ),
          }),
          Effect.matchEffect({
            onFailure: (cause) =>
              Effect.logWarning('progress.operation-failed').pipe(
                Effect.annotateLogs({ operation, cause: String(cause) }),
                Effect.as(false),
              ),
            onSuccess: Effect.succeed,
          }),
        )

      const update = (state: ChannelProgressState, status: string) =>
        Effect.gen(function* () {
          if (state.status === status) return
          const published = yield* attempt(
            'update-working',
            platforms.updateWorking({
              binding: state.thread.conversationBinding,
              text: status,
            }),
          )
          if (published) state.status = status
        })

      return ChannelProgress.of({
        accept: (thread, message, turnId) =>
          lockFor(thread.id).withPermit(
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
              if (existing && existing.turnId === turnId) return
              if (existing) {
                // A newer turn reuses the single working message. Reset tool
                // tracking so stale updates cannot leak into the new turn.
                states.set(thread.id, {
                  thread,
                  turnId,
                  activeTools: new Map(),
                  status: existing.status,
                })
                return
              }
              yield* attempt(
                'begin-working',
                platforms.beginWorking({
                  binding: thread.conversationBinding,
                  text: 'Thinking...',
                }),
              )
              states.set(thread.id, {
                thread,
                turnId,
                activeTools: new Map(),
                status: 'Thinking...',
              })
            }),
          ),
        observe: (threadId, event) =>
          lockFor(threadId).withPermit(
            Effect.gen(function* () {
              const state = states.get(threadId)
              if (!state) return
              if (state.turnId !== event.turnId) return
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
        finalize: (thread, turnId, text) =>
          lockFor(thread.id).withPermit(
            Effect.gen(function* () {
              const current = states.get(thread.id)
              if (!current || current.turnId !== turnId) return
              states.delete(thread.id)
              if (text.trim().length === 0) {
                yield* attempt(
                  'discard-working',
                  platforms.discardWorking(thread.conversationBinding),
                )
                return
              }
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

export const ChannelProgressLive = makeChannelProgressLive()
