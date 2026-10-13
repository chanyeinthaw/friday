import {
  Cache,
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  PartitionedSemaphore,
  PubSub,
  Queue,
  Scope,
  Semaphore,
  Stream,
} from 'effect'
import { Prompt } from 'effect/ai'
import {
  defineAgent,
  eventLogSource,
  startSession,
  EventLogUnavailableError,
  type FoldSession,
  type LogEntry,
  type LogEntryInput,
} from '@humanlayer/fold-core'
import {
  ServerEvent,
  type ClientCommand,
  type PendingMessage,
  type Settings,
} from '../shared/protocol.ts'
import { Storage, type StoredSettings } from './Storage.ts'
import {
  Credentials,
  configuredModel,
  discoverModels,
  normalizeBaseUrl,
  validateMapping,
} from './Providers.ts'
import { ChatGpt } from './ChatGpt.ts'
import { defaultMemoryModelId } from '../shared/modelDefaults.ts'
import { makeMemory, instructions } from './OptChat.ts'
import { completedMarkdown } from './Paragraphs.ts'
import { cachePrompt } from './CachePrompt.ts'
import { optChatTools } from './OptChatTools.ts'
import { observeText } from './StreamingModel.ts'
import { WednesdayError, failure } from './errors.ts'

export interface OwnedEvent {
  readonly userId: string
  readonly event: ServerEvent
}
export class Chat extends Context.Service<
  Chat,
  {
    readonly handle: (
      userId: string,
      command: ClientCommand,
    ) => Effect.Effect<readonly ServerEvent[], WednesdayError>
    readonly subscribe: (
      userId: string,
      afterId?: number,
    ) => Effect.Effect<Stream.Stream<ServerEvent>, WednesdayError, Scope.Scope>
  }
>()('@wednesday/Chat') {}

export const chatLayer = Layer.effect(
  Chat,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    const storage = yield* Storage
    const credentials = yield* Credentials
    const chatGpt = yield* ChatGpt
    const notifications = yield* PubSub.unbounded<OwnedEvent>()
    const locks = yield* PartitionedSemaphore.make<string>({ permits: 1 })
    type Turn = {
      readonly initial: PendingMessage
      readonly pending: PendingMessage[]
      readonly dispatched: PendingMessage[]
      session?: FoldSession
      fiber?: Fiber.Fiber<void, never>
      streaming?: { id: string; turnId: string; text: string; date: string }
      memoryIdle?: Deferred.Deferred<void>
      accepting: boolean
    }
    const active = new Map<string, Turn>()
    const receipts = yield* Cache.make({
      capacity: 10_000,
      timeToLive: '24 hours',
      lookup: (_key: string) => Effect.succeed<PendingMessage | null>(null),
    })
    const status = (userId: string): ServerEvent => {
      const turn = active.get(userId)
      return {
        _tag: 'Status',
        busy: !!turn,
        turnId: turn?.initial.requestId ?? null,
        pending: turn?.pending.slice() ?? [],
      }
    }
    const memoryOwners = yield* PartitionedSemaphore.make<string>({ permits: 1 })
    type MemoryWorker = Effect.Success<ReturnType<typeof makeMemory>> & {
      wake: Effect.Effect<void>
      stop: Effect.Effect<void>
    }
    const memories = new Map<string, MemoryWorker>()
    const getMemory = Effect.fn('Chat.memory')((userId: string, saved: StoredSettings) =>
      memoryOwners.withPermit(userId)(
        Effect.gen(function* () {
          const existing = memories.get(userId)
          if (existing) return existing
          const id =
            (saved.settings.memoryModelId ?? defaultMemoryModelId(saved.settings.models)) ||
            saved.settings.modelId
          const mapping = saved.settings.models.find((model) => model.id === id)
          if (!mapping) return yield* failure('Choose a memory model in settings.')
          const key = yield* credentials.decrypt(saved.encryptedKey)
          const model =
            saved.settings.provider === 'chatgpt'
              ? chatGpt.model(
                  userId,
                  mapping,
                  saved.settings.memoryThinking ?? 'off',
                  false,
                  `${userId}:memory`,
                )
              : configuredModel(
                  saved.settings,
                  key,
                  mapping,
                  saved.settings.memoryThinking ?? 'off',
                  `${userId}:memory`,
                )
          // Compaction requests wait while the frozen chat turn owns provider capacity.
          const beforeRequest = Effect.suspend(() => {
            const idle = active.get(userId)?.memoryIdle
            return idle ? Deferred.await(idle) : Effect.void
          })
          const memory = yield* makeMemory(
            storage,
            userId,
            model,
            undefined,
            undefined,
            beforeRequest,
          )
          const wakeups = yield* Queue.sliding<void>(1)
          const worker = yield* Effect.forever(
            Effect.gen(function* () {
              yield* Queue.take(wakeups)
              yield* memory
                .pump()
                .pipe(
                  Effect.catch(() =>
                    Effect.logWarning('Wednesday memory will retry on the next message'),
                  ),
                )
            }),
          ).pipe(Effect.forkIn(scope))
          const result = {
            ...memory,
            wake: Queue.offer(wakeups, undefined).pipe(Effect.asVoid),
            stop: Fiber.interrupt(worker).pipe(Effect.asVoid),
          }
          memories.set(userId, result)
          return result
        }),
      ),
    )
    const publish = (userId: string, event: ServerEvent) =>
      PubSub.publish(notifications, { userId, event }).pipe(Effect.asVoid)
    yield* storage.recover()

    const run = Effect.fn('Chat.run')(function* (userId: string, turn: Turn) {
      const submission = turn.initial
      const saved = yield* storage.settings(userId)
      if (!saved) return yield* failure('Configure your API connection and model first.')
      const mapping = saved.settings.models.find((model) => model.id === saved.settings.modelId)
      if (!mapping || !mapping.thinking[saved.settings.thinking])
        return yield* failure('Select a model and a supported thinking level in settings.')
      const key = yield* credentials.decrypt(saved.encryptedKey)
      const model =
        saved.settings.provider === 'chatgpt'
          ? chatGpt.model(userId, mapping, saved.settings.thinking)
          : configuredModel(saved.settings, key, mapping, saved.settings.thinking, userId)
      const parts = new Map<string, string>()
      let responseCount = 0
      const streamedModel = {
        ...model,
        make: model.make.pipe(
          Effect.map((implementation) =>
            observeText(implementation, (part) => {
              parts.set(part.id, (parts.get(part.id) ?? '') + part.delta)
              if (!part.delta.includes('\n')) return Effect.void
              const text = completedMarkdown([...parts.values()].join('\n\n'))
              if (!text || text === turn.streaming?.text) return Effect.void
              return locks.withPermit(userId)(
                Effect.gen(function* () {
                  if (active.get(userId) !== turn) return
                  turn.streaming = {
                    id: `${submission.requestId}-${responseCount}`,
                    turnId: submission.requestId,
                    text,
                    date: turn.streaming?.date ?? new Date().toISOString(),
                  }
                  yield* publish(userId, { _tag: 'Streaming', message: turn.streaming })
                }),
              )
            }),
          ),
        ),
      } satisfies typeof model
      const memory = yield* getMemory(userId, saved)
      const view = yield* memory.settle()
      turn.memoryIdle = yield* Deferred.make<void>()
      const firstSeq = yield* storage.logSequence(userId)
      const logEvents = yield* PubSub.unbounded<LogEntry>()
      const logGate = yield* Semaphore.make(1)
      let requestStart: number | undefined
      let initialLogged = false
      const logError = () =>
        new EventLogUnavailableError({
          operation: 'append',
          message: 'Could not persist conversation.',
          retryable: false,
        })
      const append = (input: LogEntryInput) =>
        logGate.withPermit(
          locks.withPermit(userId)(
            Effect.gen(function* () {
              let consumedRequestId: string | null = null
              if (input._tag === 'user-message') {
                if (!initialLogged) {
                  consumedRequestId = submission.requestId
                  initialLogged = true
                } else {
                  consumedRequestId = turn.dispatched.shift()?.requestId ?? null
                }
              }
              const result = yield* storage
                .appendLog(
                  userId,
                  input,
                  consumedRequestId,
                  turn.pending.find((item) => item.requestId === consumedRequestId)?.date,
                )
                .pipe(Effect.mapError(logError))
              if (result.messages.length) yield* memory.wake
              if (consumedRequestId) {
                const index = turn.pending.findIndex((item) => item.requestId === consumedRequestId)
                if (index >= 0) turn.pending.splice(index, 1)
              }
              const streamId = turn.streaming?.id
              const firstTalk = result.messages.findIndex((message) => message.kind === 'talk')
              if (input._tag === 'assistant-message') {
                responseCount++
                parts.clear()
                delete turn.streaming
              }
              for (const [index, message] of result.messages.entries())
                yield* publish(userId, {
                  _tag: 'Message',
                  message:
                    streamId && index === firstTalk
                      ? Object.assign({}, message, { streamId })
                      : message,
                  completesStreaming:
                    input._tag === 'assistant-message' &&
                    index === (firstTalk >= 0 ? firstTalk : 0),
                })
              if (input._tag === 'assistant-message' && !result.messages.length)
                yield* publish(userId, { _tag: 'Streaming', message: null })
              yield* publish(userId, status(userId))
              yield* PubSub.publish(logEvents, result.entry)
              return result.entry
            }),
          ),
        )
      const entries = (fromSeq = 0) =>
        Stream.fromIterableEffect(
          storage.logs(userId, Math.max(firstSeq, fromSeq)).pipe(
            Effect.map((rows) => rows.filter((row) => row.seq >= fromSeq)),
            Effect.mapError(logError),
          ),
        )
      const subscribe = (fromSeq = 0) =>
        Stream.unwrap(
          logGate.withPermit(
            Effect.gen(function* () {
              const subscription = yield* PubSub.subscribe(logEvents)
              const snapshot = yield* storage
                .logs(userId, Math.max(firstSeq, fromSeq))
                .pipe(Effect.mapError(logError))
              return Stream.fromIterable(snapshot.filter((row) => row.seq >= fromSeq)).pipe(
                Stream.concat(
                  Stream.fromSubscription(subscription).pipe(
                    Stream.filter((row) => row.seq >= fromSeq),
                  ),
                ),
              )
            }),
          ),
        )
      const agent = defineAgent({
        name: 'Friday',
        model: streamedModel,
        systemPrompt: instructions,
        autoCompact: { enabled: false },
        tools: optChatTools(memory),
        hooks: {
          preRequest: [
            {
              name: 'OptChat.frozenView',
              handler: (input) =>
                Effect.gen(function* () {
                  yield* locks.withPermit(userId)(flushSteering(turn))
                  if (requestStart === undefined) {
                    requestStart = input.prompt.content.findLastIndex(
                      (message) =>
                        message.role === 'user' &&
                        message.content.some(
                          (part) => part.type === 'text' && part.text === submission.text,
                        ),
                    )
                  }
                  if (requestStart < 0)
                    throw new Error('Current input is missing from the Fold request')
                  return {
                    _tag: 'changed' as const,
                    prompt: Prompt.make([
                      { role: 'system', content: instructions },
                      ...cachePrompt(view, input.prompt.content.slice(requestStart)).content,
                    ]),
                  }
                }),
            },
          ],
        },
      })
      const log = eventLogSource(Effect.succeed({ append, entries, subscribe }))
      const session = yield* startSession({ agent, log, steering: 'one-at-a-time' })
      turn.session = session
      const result = yield* session.send(submission.text)
      if (result.outcome === 'error')
        return yield* failure('The provider could not complete the response.')
    })

    const flushSteering = Effect.fn('Chat.flushSteering')(function* (turn: Turn) {
      if (!turn.session || !turn.accepting) return
      for (const item of turn.pending) {
        if (
          item.mode !== 'steer' ||
          turn.dispatched.some((sent) => sent.requestId === item.requestId)
        )
          continue
        const sent = yield* turn.session.steer(item.text).pipe(
          Effect.as(true),
          Effect.catchTag('AgentNotRunningError', () => Effect.succeed(false)),
        )
        if (sent) turn.dispatched.push(item)
      }
    })

    const finish = Effect.fn('Chat.finish')((userId: string, turn: Turn) =>
      locks.withPermit(userId)(
        Effect.gen(function* () {
          if (active.get(userId) !== turn) return
          turn.accepting = false
          if (turn.pending.length)
            yield* publish(userId, {
              _tag: 'Discarded',
              requestIds: turn.pending.map((item) => item.requestId),
              message: 'This response ended before using your message.',
            })
          active.delete(userId)
          if (turn.memoryIdle) yield* Deferred.succeed(turn.memoryIdle, undefined)
          yield* publish(userId, status(userId))
        }),
      ),
    )

    const validateModelSelection = Effect.fn('Chat.validateModelSelection')(function* (
      settings: Settings,
    ) {
      for (const mapping of settings.models) yield* validateMapping(mapping)
      const model = settings.models.find((item) => item.id === settings.modelId)
      if (!model || !model.thinking[settings.thinking])
        return yield* failure('Choose a model and a supported thinking level.')
      if (new Set(settings.models.map((item) => item.id)).size !== settings.models.length)
        return yield* failure('Model IDs must be unique.')
      if (
        settings.memoryModelId &&
        !settings.models.some((model) => model.id === settings.memoryModelId)
      )
        return yield* failure('Choose a memory model from your model list.')
      const memoryId =
        (settings.memoryModelId ?? defaultMemoryModelId(settings.models)) || settings.modelId
      const memory = settings.models.find((item) => item.id === memoryId)
      if (!memory?.thinking[settings.memoryThinking ?? 'off'])
        return yield* failure('Choose a supported thinking level for the memory model.')
    })

    const saveSettings = Effect.fn('Chat.saveSettings')(function* (
      userId: string,
      command: Extract<ClientCommand, { _tag: 'SaveSettings' }>,
    ) {
      if (active.has(userId))
        return yield* failure('Wait for the current turn to finish before changing settings.')
      const baseUrl = yield* normalizeBaseUrl(command.settings.baseUrl)
      yield* validateModelSelection(command.settings)
      const previous = yield* storage.settings(userId)
      if (
        command.settings.provider === 'chatgpt' &&
        (previous?.settings.provider !== 'chatgpt' || !previous.encryptedKey)
      )
        return yield* failure('Sign in with ChatGPT first.')
      if (
        !command.apiKey &&
        (previous?.settings.baseUrl !== baseUrl ||
          (previous?.settings.provider === 'chatgpt' && command.settings.provider !== 'chatgpt'))
      )
        return yield* failure('Enter an API key when changing the API URL.')
      const encryptedKey =
        command.settings.provider === 'chatgpt'
          ? previous?.encryptedKey
          : command.apiKey
            ? yield* credentials.encrypt(command.apiKey)
            : previous?.encryptedKey
      if (!encryptedKey) return yield* failure('Enter an API key.')
      yield* chatGpt.cancel(userId)
      yield* storage.saveSettings(userId, {
        settings: { ...command.settings, baseUrl },
        encryptedKey,
      })
      yield* memoryOwners.withPermit(userId)(
        Effect.gen(function* () {
          yield* memories.get(userId)?.stop ?? Effect.void
          memories.delete(userId)
          yield* storage.retryMemoryJobs(userId)
        }),
      )
      yield* publish(userId, {
        _tag: 'SettingsChanged',
        settings: { ...command.settings, baseUrl },
      })
      return [{ _tag: 'Saved' as const }]
    })

    const discover = Effect.fn('Chat.discover')(function* (
      userId: string,
      command: Extract<ClientCommand, { _tag: 'DiscoverModels' }>,
    ) {
      const previous = yield* storage.settings(userId)
      if (
        previous?.settings.provider === 'chatgpt' &&
        !command.apiFormat &&
        command.baseUrl === previous.settings.baseUrl
      )
        return [{ _tag: 'Models' as const, models: yield* chatGpt.models(userId) }]
      const baseUrl = yield* normalizeBaseUrl(command.baseUrl)
      if (
        !command.apiKey &&
        (previous?.settings.baseUrl !== baseUrl || previous?.settings.provider === 'chatgpt')
      )
        return yield* failure('Enter an API key for this API URL.')
      const encrypted = command.apiKey
        ? yield* credentials.encrypt(command.apiKey)
        : previous?.encryptedKey
      if (!encrypted) return yield* failure('Enter an API key.')
      const discovered = yield* discoverModels(
        baseUrl,
        yield* credentials.decrypt(encrypted),
        command.apiFormat,
      )
      const models = discovered.map((model) =>
        previous?.settings.baseUrl === baseUrl &&
        (previous.settings.apiFormat ?? 'chat-completions') ===
          (command.apiFormat ?? 'chat-completions')
          ? (previous.settings.models.find((saved) => saved.id === model.id) ?? model)
          : model,
      )
      return [{ _tag: 'Models' as const, models }]
    })

    const snapshot = Effect.fn('Chat.snapshot')(function* (userId: string, afterId = -1) {
      const saved = yield* storage.settings(userId)
      const turn = active.get(userId)
      const page = afterId < 0 ? yield* storage.history(userId) : null
      const result = {
        _tag: 'Snapshot' as const,
        settings: saved?.settings ?? null,
        hasApiKey: !!saved?.encryptedKey,
        messages: page ? page.messages : yield* storage.messages(userId, afterId),
        busy: !!turn,
        turnId: turn?.initial.requestId ?? null,
        pending: turn?.pending.slice() ?? [],
        streaming: turn?.streaming ?? null,
      }
      return page ? { ...result, hasOlder: page.hasOlder } : result
    })
    const submit = Effect.fn('Chat.submit')(function* (
      userId: string,
      command: Extract<ClientCommand, { _tag: 'Send' | 'Steer' }>,
    ) {
      const receiptKey = `${userId}:${command.requestId}`
      const cached = yield* Cache.getOption(receipts, receiptKey)
      if (cached._tag === 'Some' && cached.value) {
        const previous = cached.value
        if (
          previous.text !== command.text ||
          (command._tag === 'Steer' && command.turnId !== previous.turnId)
        )
          return yield* failure('This message ID was already used for another message.')
        return [{ _tag: 'Accepted' as const, requestId: command.requestId, mode: previous.mode }]
      }
      let turn = active.get(userId)
      if (command._tag === 'Steer' && (!turn || command.turnId !== turn.initial.requestId))
        return yield* failure('That response has ended. Edit your message to send it again.')
      if (turn && !turn.accepting) return yield* failure('This response is stopping.')
      const mode = turn ? ('steer' as const) : ('send' as const)
      const item: PendingMessage = {
        requestId: command.requestId,
        text: command.text,
        mode,
        status: 'waiting',
        date: new Date().toISOString(),
        turnId: turn?.initial.requestId ?? command.requestId,
      }
      if (!turn) {
        const saved = yield* storage.settings(userId)
        if (!saved) return yield* failure('Configure your API connection and model first.')
        turn = { initial: item, pending: [item], dispatched: [], accepting: true }
        active.set(userId, turn)
        const current = turn
        current.fiber = yield* run(userId, current).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterrupts(cause)) return
              yield* publish(userId, {
                _tag: 'Error',
                requestId: item.requestId,
                message: 'The response failed. Check your provider settings and try again.',
              })
              yield* Effect.logError('Wednesday turn failed')
            }),
          ),
          Effect.ensuring(finish(userId, current)),
          Effect.forkIn(scope),
        )
      } else {
        turn.pending.push(item)
        yield* flushSteering(turn)
      }
      yield* Cache.set(receipts, receiptKey, item)
      yield* publish(userId, status(userId))
      return [{ _tag: 'Accepted' as const, requestId: command.requestId, mode }]
    })
    const handle = Effect.fn('Chat.handle')(function* (userId: string, command: ClientCommand) {
      if (command._tag === 'Stop') {
        const fiber = yield* locks.withPermit(userId)(
          Effect.sync(() => {
            const turn = active.get(userId)
            if (!turn || (command.turnId && command.turnId !== turn.initial.requestId)) return
            turn.accepting = false
            return turn.fiber
          }),
        )
        if (fiber) yield* Fiber.interrupt(fiber)
        return []
      }
      if (command._tag === 'CancelChatGpt') {
        yield* chatGpt.cancel(userId, command.attemptId)
        return [{ _tag: 'ChatGptCancelled' as const }]
      }
      if (command._tag === 'DiscoverModels') return yield* discover(userId, command)
      return yield* locks.withPermit(userId)(
        Effect.gen(function* () {
          if (
            ['StartChatGpt', 'PollChatGpt', 'DisconnectChatGpt'].includes(command._tag) &&
            active.has(userId)
          )
            return yield* failure('Wait for the current response before changing providers.')
          switch (command._tag) {
            case 'StartChatGpt':
              return [
                {
                  _tag: 'ChatGptAuthorization' as const,
                  authorization: yield* chatGpt.begin(userId),
                },
              ]
            case 'PollChatGpt': {
              const result = yield* chatGpt.poll(userId, command.attemptId)
              if (!result)
                return [{ _tag: 'ChatGptPending' as const, attemptId: command.attemptId }]
              const selected = result.models[0]
              if (!selected) return yield* failure('No ChatGPT models are available.')
              const settings = {
                provider: 'chatgpt' as const,
                baseUrl: 'https://chatgpt.com/backend-api/codex',
                modelId: selected.id,
                models: result.models,
                thinking: 'off' as const,
                memoryModelId: defaultMemoryModelId(result.models),
                memoryThinking: 'off' as const,
              }
              yield* storage.saveSettings(userId, { settings, encryptedKey: result.encryptedKey })
              yield* chatGpt.cancel(userId, command.attemptId)
              yield* memoryOwners.withPermit(userId)(
                Effect.gen(function* () {
                  yield* memories.get(userId)?.stop ?? Effect.void
                  memories.delete(userId)
                  yield* storage.retryMemoryJobs(userId)
                }),
              )
              yield* publish(userId, { _tag: 'SettingsChanged', settings })
              return [{ _tag: 'ChatGptConnected' as const, settings }, yield* snapshot(userId)]
            }
            case 'DisconnectChatGpt': {
              yield* chatGpt.cancel(userId)
              const saved = yield* storage.settings(userId)
              if (saved?.settings.provider !== 'chatgpt') return []
              yield* storage.saveSettings(userId, {
                encryptedKey: '',
                settings: {
                  provider: 'api',
                  baseUrl: 'https://api.openai.com/v1',
                  modelId: '',
                  models: [],
                  thinking: 'off',
                  memoryModelId: '',
                  memoryThinking: 'off',
                },
              })
              yield* memoryOwners.withPermit(userId)(
                Effect.gen(function* () {
                  yield* memories.get(userId)?.stop ?? Effect.void
                  memories.delete(userId)
                }),
              )
              const next = yield* snapshot(userId)
              yield* publish(userId, next)
              return [next]
            }
            case 'LoadOlder':
              return [
                { _tag: 'History' as const, ...(yield* storage.history(userId, command.beforeId)) },
              ]
            case 'Load':
              return [yield* snapshot(userId, command.afterId)]
            case 'SaveSettings':
              return yield* saveSettings(userId, command)
            case 'Send':
            case 'Steer':
              return yield* submit(userId, command)
          }
        }),
      )
    })
    const subscribe = Effect.fn('Chat.subscribe')((userId: string, afterId = -1) =>
      locks.withPermit(userId)(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(notifications)
          const initial = yield* snapshot(userId, afterId)
          return Stream.make(initial).pipe(
            Stream.concat(
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((item) => item.userId === userId),
                Stream.map((item) => item.event),
              ),
            ),
          )
        }),
      ),
    )
    return Chat.of({ handle, subscribe })
  }),
)
