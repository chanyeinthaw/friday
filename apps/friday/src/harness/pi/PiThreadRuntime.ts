/* oxlint-disable anti-slop/no-unknown-parameters, eslint/no-underscore-dangle -- Pi SDK tool results are unknown at the harness boundary and Effect exits use the canonical _tag discriminator. */

import {
  ActivityId,
  HarnessSessionId,
  ToolCallId,
  type Activity,
  type ToolCallId as ToolCallIdType,
  type IsoDateTime,
  type Thread,
  type TokenUsage,
  type TurnId,
} from '@friday/contracts/conversation'
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import type {
  PromptRequest,
  ThreadRuntime,
  ThreadRuntimeEvent,
} from '../../conversation/ThreadRuntime.ts'

const PiResumeCursor = Schema.Struct({
  sessionFile: Schema.String,
  sessionId: Schema.String,
})
const decodePiResumeCursor = Schema.decodeUnknownOption(PiResumeCursor)
const decodeActivityId = Schema.decodeSync(ActivityId)
const decodeHarnessSessionId = Schema.decodeSync(HarnessSessionId)
const decodeToolCallId = Schema.decodeSync(ToolCallId)
const decodeJson = Schema.decodeUnknownOption(Schema.Json)

export class PiThreadRuntimeError extends Schema.Error<PiThreadRuntimeError>(
  'PiThreadRuntimeError',
)({
  _tag: Schema.tag('PiThreadRuntimeError'),
  operation: Schema.Literals([
    'resolve-model',
    'create-session',
    'bind-extensions',
    'prompt',
    'steer',
    'attachments',
  ]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ActivePiTool {
  readonly turnId: TurnId
  readonly activityId: Activity['id']
  readonly callId: ToolCallIdType
  readonly sequence: number
  readonly createdAt: IsoDateTime
  output: Schema.Json
}

export interface PiProjectionState {
  activeTurnId: TurnId | null
  nextSequence: number
  finalAgentMessage: string
  terminalFailure: { readonly interrupted: boolean; readonly message: string } | null
  readonly activeTools: Map<string, ActivePiTool>
}

export interface PiAgentSessionContract {
  readonly sessionId: AgentSession['sessionId']
  readonly sessionManager: Pick<AgentSession['sessionManager'], 'getSessionFile'>
  readonly subscribe: AgentSession['subscribe']
  readonly bindExtensions: AgentSession['bindExtensions']
  readonly prompt: AgentSession['prompt']
  readonly abort: AgentSession['abort']
  readonly dispose: AgentSession['dispose']
  readonly getSessionStats: AgentSession['getSessionStats']
}

export interface MakePiThreadRuntimeOptions {
  readonly thread: Thread
  readonly modelRuntime?: ModelRuntime
  readonly createSession?: (
    options: CreateAgentSessionOptions,
  ) => Promise<{ readonly session: PiAgentSessionContract }>
  readonly sessionFactory?: (
    thread: Thread,
  ) => Effect.Effect<PiAgentSessionContract, PiThreadRuntimeError>
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

const messageText = (event: AgentSessionEvent): string | undefined => {
  if (event.type !== 'message_end' || event.message.role !== 'assistant') return undefined
  return event.message.content
    .flatMap((content) => (content.type === 'text' ? [content.text] : []))
    .join('')
}

const jsonOutput = (value: unknown): Schema.Json =>
  Option.getOrElse(decodeJson(value), () => String(value))

const tokenUsage = (session: PiAgentSessionContract): TokenUsage => {
  const stats = session.getSessionStats()
  return {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    totalTokens: stats.tokens.total,
  }
}

const emitToolStart = Effect.fn('emitPiToolStart')(function* (input: {
  readonly state: PiProjectionState
  readonly event: Extract<AgentSessionEvent, { readonly type: 'tool_execution_start' }>
  readonly emit: (event: ThreadRuntimeEvent) => Effect.Effect<void>
  readonly makeActivityId: Effect.Effect<Activity['id'], PiThreadRuntimeError>
}) {
  const turnId = input.state.activeTurnId
  if (turnId === null) return
  const createdAt = yield* nowIso
  const callId = decodeToolCallId(input.event.toolCallId)
  const callActivity: Activity = {
    id: yield* input.makeActivityId,
    sequence: input.state.nextSequence++,
    status: 'completed',
    type: 'tool-call',
    callId,
    toolName: input.event.toolName,
    input: jsonOutput(input.event.args),
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  }
  const resultActivity: Activity = {
    id: yield* input.makeActivityId,
    sequence: input.state.nextSequence++,
    status: 'active',
    type: 'tool-result',
    callId,
    output: null,
    isError: false,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  }
  input.state.activeTools.set(input.event.toolCallId, {
    turnId,
    activityId: resultActivity.id,
    callId,
    sequence: resultActivity.sequence,
    createdAt,
    output: null,
  })
  yield* input.emit({ type: 'activity-completed', turnId, activity: callActivity })
  yield* input.emit({ type: 'activity-started', turnId, activity: resultActivity })
})

const emitToolSnapshot = Effect.fn('emitPiToolSnapshot')(function* (input: {
  readonly state: PiProjectionState
  readonly toolCallId: string
  readonly output: unknown
  readonly isError: boolean
  readonly completed: boolean
  readonly emit: (event: ThreadRuntimeEvent) => Effect.Effect<void>
}) {
  const active = input.state.activeTools.get(input.toolCallId)
  if (!active) return
  const updatedAt = yield* nowIso
  active.output = jsonOutput(input.output)
  const activity: Activity = {
    id: active.activityId,
    sequence: active.sequence,
    status: input.completed ? 'completed' : 'active',
    type: 'tool-result',
    callId: active.callId,
    output: active.output,
    isError: input.isError,
    createdAt: active.createdAt,
    updatedAt,
    completedAt: input.completed ? updatedAt : null,
  }
  yield* input.emit({
    type: input.completed ? 'activity-completed' : 'activity-updated',
    turnId: active.turnId,
    activity,
  })
  if (input.completed) input.state.activeTools.delete(input.toolCallId)
})

export const projectPiSessionEvent = Effect.fn('projectPiSessionEvent')(function* (input: {
  readonly state: PiProjectionState
  readonly event: AgentSessionEvent
  readonly emit: (event: ThreadRuntimeEvent) => Effect.Effect<void>
  readonly makeActivityId: Effect.Effect<Activity['id'], PiThreadRuntimeError>
}) {
  switch (input.event.type) {
    case 'message_end': {
      const text = messageText(input.event)
      if (text !== undefined) input.state.finalAgentMessage = text
      if (input.event.message.role === 'assistant') {
        const stopReason = input.event.message.stopReason
        if (
          (stopReason === 'error' || stopReason === 'aborted') &&
          input.state.terminalFailure === null
        ) {
          input.state.terminalFailure = {
            interrupted: stopReason === 'aborted',
            message:
              input.event.message.errorMessage ??
              (stopReason === 'aborted' ? 'Pi request was aborted.' : 'Pi returned an error.'),
          }
        }
      }
      return
    }
    case 'tool_execution_start':
      yield* emitToolStart({ ...input, event: input.event })
      return
    case 'tool_execution_update':
      yield* emitToolSnapshot({
        ...input,
        toolCallId: input.event.toolCallId,
        output: input.event.partialResult,
        isError: false,
        completed: false,
      })
      return
    case 'tool_execution_end':
      yield* emitToolSnapshot({
        ...input,
        toolCallId: input.event.toolCallId,
        output: input.event.result,
        isError: input.event.isError,
        completed: true,
      })
      return
    default:
      return
  }
})

const makeSession = Effect.fn('makePiAgentSession')(function* (
  options: MakePiThreadRuntimeOptions,
) {
  const modelRuntime = options.modelRuntime
  if (!modelRuntime) {
    return yield* new PiThreadRuntimeError({
      operation: 'create-session',
      detail: 'Pi ModelRuntime is required when no custom session factory is provided.',
    })
  }
  const model = modelRuntime.getModel(options.thread.model.provider, options.thread.model.modelId)
  if (!model) {
    return yield* new PiThreadRuntimeError({
      operation: 'resolve-model',
      detail: `Pi model '${options.thread.model.provider}/${options.thread.model.modelId}' was not found.`,
    })
  }
  const authenticated = yield* Effect.tryPromise({
    try: () => modelRuntime.getAuth(model),
    catch: (cause) =>
      new PiThreadRuntimeError({
        operation: 'resolve-model',
        detail: errorDetail(cause),
        cause,
      }),
  })
  if (!authenticated) {
    return yield* new PiThreadRuntimeError({
      operation: 'resolve-model',
      detail: `Pi model '${model.provider}/${model.id}' has no configured authentication.`,
    })
  }
  const resumeCursor = Option.flatMap(
    Option.fromNullishOr(options.thread.harnessSession),
    ({ resumeCursor: cursor }) => decodePiResumeCursor(cursor),
  )
  const sessionManager = Option.match(resumeCursor, {
    onNone: () => undefined,
    onSome: ({ sessionFile }) =>
      SessionManager.open(sessionFile, undefined, options.thread.workingDirectory),
  })
  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.thread.workingDirectory,
    modelRuntime,
    model,
    thinkingLevel: options.thread.thinkingLevel,
  }
  if (sessionManager) sessionOptions.sessionManager = sessionManager
  const created = yield* Effect.tryPromise({
    try: () => (options.createSession ?? createAgentSession)(sessionOptions),
    catch: (cause) =>
      new PiThreadRuntimeError({
        operation: 'create-session',
        detail: errorDetail(cause),
        cause,
      }),
  })
  yield* Effect.tryPromise({
    try: () => created.session.bindExtensions({ mode: 'rpc' }),
    catch: (cause) =>
      new PiThreadRuntimeError({
        operation: 'bind-extensions',
        detail: errorDetail(cause),
        cause,
      }),
  })
  return created
})

export const makePiThreadRuntime = Effect.fn('makePiThreadRuntime')(function* (
  options: MakePiThreadRuntimeOptions,
) {
  const session = options.sessionFactory
    ? yield* options.sessionFactory(options.thread)
    : (yield* makeSession(options)).session
  const crypto = yield* Crypto.Crypto
  const makeActivityId = crypto.randomUUIDv4.pipe(
    Effect.map((id) => decodeActivityId(`activity-${id}`)),
    Effect.mapError(
      (cause) =>
        new PiThreadRuntimeError({
          operation: 'create-session',
          detail: 'Failed to generate a Pi Activity identifier.',
          cause,
        }),
    ),
  )
  const eventsQueue = yield* Queue.unbounded<ThreadRuntimeEvent>()
  const projectionLock = yield* Semaphore.make(1)
  const sessionLock = yield* Semaphore.make(1)
  const queuedSteering: Array<PromptRequest> = []
  const sessionState = {
    compacting: false,
    drainingSteering: false,
    queuedSteering,
  }
  const state: PiProjectionState = {
    activeTurnId: null,
    nextSequence: 0,
    finalAgentMessage: '',
    terminalFailure: null,
    activeTools: new Map(),
  }
  const effectContext = yield* Effect.context()
  const runPromise = Effect.runPromiseWith(effectContext)
  const emit = (event: ThreadRuntimeEvent) => Queue.offer(eventsQueue, event).pipe(Effect.asVoid)
  const sendSteering = (request: PromptRequest) =>
    Effect.tryPromise({
      try: () => session.prompt(request.message.content.text, { streamingBehavior: 'steer' }),
      catch: (cause) =>
        new PiThreadRuntimeError({
          operation: 'steer',
          detail: errorDetail(cause),
          cause,
        }),
    })
  const drainSteering = Effect.gen(function* () {
    while (true) {
      const request = yield* sessionLock.withPermit(
        Effect.sync(() => {
          const queued = sessionState.queuedSteering.at(0)
          if (!queued) sessionState.drainingSteering = false
          return queued
        }),
      )
      if (!request) return
      yield* sendSteering(request).pipe(
        Effect.tapError(() =>
          sessionLock.withPermit(
            Effect.sync(() => {
              sessionState.drainingSteering = false
            }),
          ),
        ),
      )
      yield* sessionLock.withPermit(
        Effect.sync(() => {
          sessionState.queuedSteering.shift()
        }),
      )
    }
  })
  const failActiveTurnFromSteering = Effect.fn('PiThreadRuntime.failActiveTurnFromSteering')(
    function* (error: PiThreadRuntimeError) {
      if (state.activeTurnId === null) {
        yield* Effect.logError('Deferred Pi steering delivery failed without an active Turn', {
          error,
        })
        return
      }
      state.terminalFailure = {
        interrupted: false,
        message: `Deferred Pi steering delivery failed: ${error.detail}`,
      }
      yield* Effect.tryPromise({
        try: () => session.abort(),
        catch: () => undefined,
      }).pipe(Effect.ignore)
    },
  )
  const unsubscribe = session.subscribe((event) => {
    let shouldDrain = false
    if (event.type === 'compaction_start') sessionState.compacting = true
    if (event.type === 'compaction_end') {
      sessionState.compacting = false
      if (!sessionState.drainingSteering && sessionState.queuedSteering.length > 0) {
        sessionState.drainingSteering = true
        shouldDrain = true
      }
    }
    const compaction = shouldDrain
      ? drainSteering.pipe(Effect.catchTag('PiThreadRuntimeError', failActiveTurnFromSteering))
      : Effect.void
    return runPromise(
      compaction.pipe(
        Effect.andThen(
          projectionLock.withPermit(projectPiSessionEvent({ state, event, emit, makeActivityId })),
        ),
        Effect.catchCause((cause) => Effect.logError('Pi event handling failed', { cause })),
      ),
    )
  })
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      unsubscribe()
      yield* Effect.tryPromise({
        try: () => session.abort(),
        catch: () => undefined,
      }).pipe(Effect.ignore)
      yield* Effect.sync(() => session.dispose()).pipe(Effect.ignore)
      yield* Queue.shutdown(eventsQueue)
    }),
  )

  const prompt = Effect.fn('PiThreadRuntime.prompt')(function* (request: PromptRequest) {
    if (request.message.content.images.length > 0) {
      return yield* new PiThreadRuntimeError({
        operation: 'attachments',
        detail: 'Pi image attachment loading is not implemented yet.',
      })
    }
    const text = request.message.content.text
    const mode = request.mode ?? 'steer'
    if (mode === 'steer') {
      const disposition = yield* sessionLock.withPermit(
        Effect.sync(() => {
          if (
            !sessionState.compacting &&
            !sessionState.drainingSteering &&
            sessionState.queuedSteering.length === 0
          ) {
            return 'send' as const
          }
          sessionState.queuedSteering.push(request)
          if (!sessionState.compacting && !sessionState.drainingSteering) {
            sessionState.drainingSteering = true
            return 'drain' as const
          }
          return 'queued' as const
        }),
      )
      if (disposition === 'send') yield* sessionLock.withPermit(sendSteering(request))
      if (disposition === 'drain') yield* drainSteering
      return undefined
    }

    state.activeTurnId = request.turnId
    state.nextSequence = 0
    state.finalAgentMessage = ''
    state.terminalFailure = null
    state.activeTools.clear()
    yield* emit({
      type: 'turn-started',
      turnId: request.turnId,
      harnessTurnId: null,
      startedAt: yield* nowIso,
    })
    const result = yield* Effect.tryPromise({
      try: () => session.prompt(text),
      catch: (cause) =>
        new PiThreadRuntimeError({
          operation: 'prompt',
          detail: errorDetail(cause),
          cause,
        }),
    }).pipe(Effect.exit)
    const completedAt = yield* nowIso
    if (result._tag === 'Failure') {
      yield* emit({
        type: 'turn-failed',
        turnId: request.turnId,
        errorMessage: 'Pi prompt failed.',
        completedAt,
      })
      state.activeTurnId = null
      return yield* result
    }
    const failure: PiProjectionState['terminalFailure'] = yield* Effect.sync(
      () => state.terminalFailure,
    )
    if (failure?.interrupted) {
      yield* emit({
        type: 'turn-interrupted',
        turnId: request.turnId,
        agentMessage: state.finalAgentMessage || null,
        usage: tokenUsage(session),
        completedAt,
      })
    } else if (failure) {
      yield* emit({
        type: 'turn-failed',
        turnId: request.turnId,
        errorMessage: failure.message,
        completedAt,
      })
    } else {
      yield* emit({
        type: 'turn-completed',
        turnId: request.turnId,
        agentMessage: state.finalAgentMessage,
        usage: tokenUsage(session),
        completedAt,
      })
    }
    state.activeTurnId = null
    return undefined
  })

  const sessionFile = session.sessionManager.getSessionFile()
  return {
    threadId: options.thread.id,
    harnessSession: {
      id: decodeHarnessSessionId(session.sessionId),
      resumeCursor: sessionFile
        ? { sessionFile, sessionId: session.sessionId }
        : { sessionId: session.sessionId },
    },
    prompt,
    events: Stream.fromQueue(eventsQueue),
  } satisfies ThreadRuntime<PiThreadRuntimeError>
})
