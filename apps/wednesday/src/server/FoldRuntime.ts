import { Effect, Layer, Stream, PubSub, Semaphore } from 'effect'
import { Prompt } from 'effect/ai'
import {
  defineAgent,
  eventLogSource,
  startSession,
  EventLogUnavailableError,
  type LogEntry,
} from '@humanlayer/fold-core'
import { AgentRuntime, type AgentImage, type AgentOptions } from './AgentRuntime.ts'
import { cachePrompt } from './CachePrompt.ts'
import { optChatTools } from './OptChatTools.ts'
import { observeText } from './StreamingModel.ts'
import { ChatGpt } from './ChatGpt.ts'
import { configuredModel } from './Providers.ts'
import { failure } from './errors.ts'

export const foldRuntimeLayer = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const chatGpt = yield* ChatGpt
    return AgentRuntime.of({
      open: Effect.fn('FoldRuntime.open')(
        function* (options: AgentOptions) {
          const connection = options.connection
          const credential = yield* connection.credential
          const base =
            connection.settings.provider === 'chatgpt'
              ? chatGpt.model(
                  connection.userId,
                  connection.mapping,
                  connection.thinking,
                  connection.purpose === 'chat',
                  connection.cacheKey,
                )
              : configuredModel(
                  connection.settings,
                  credential.apiKey,
                  connection.mapping,
                  connection.thinking,
                  connection.cacheKey,
                )
          const onText = options.onText
          const model = onText
            ? {
                ...base,
                make: base.make.pipe(
                  Effect.map((implementation) => observeText(implementation, onText)),
                ),
              }
            : base
          const imageInputs = new Map<string, readonly AgentImage[]>()
          let requestStart: number | undefined
          const rows: LogEntry[] = []
          const events = yield* PubSub.unbounded<LogEntry>()
          const gate = yield* Semaphore.make(1)
          const append = options.append
          const log = append
            ? eventLogSource(
                Effect.succeed({
                  append: (input) =>
                    gate.withPermit(
                      Effect.gen(function* () {
                        const entry = yield* append(input).pipe(
                          Effect.mapError(
                            () =>
                              new EventLogUnavailableError({
                                operation: 'append',
                                message: 'Could not persist conversation.',
                                retryable: false,
                              }),
                          ),
                        )
                        rows.push(entry)
                        yield* PubSub.publish(events, entry)
                        return entry
                      }),
                    ),
                  entries: (fromSeq = 0) =>
                    Stream.fromIterableEffect(
                      Effect.sync(() => rows.filter((entry) => entry.seq >= fromSeq)),
                    ),
                  subscribe: (fromSeq = 0) =>
                    Stream.unwrap(
                      gate.withPermit(
                        Effect.gen(function* () {
                          const subscription = yield* PubSub.subscribe(events)
                          return Stream.fromIterable(
                            rows.filter((entry) => entry.seq >= fromSeq),
                          ).pipe(
                            Stream.concat(
                              Stream.fromSubscription(subscription).pipe(
                                Stream.filter((entry) => entry.seq >= fromSeq),
                              ),
                            ),
                          )
                        }),
                      ),
                    ),
                }),
              )
            : undefined
          const session = yield* startSession({
            agent: defineAgent({
              name: 'Friday',
              model,
              systemPrompt: options.systemPrompt,
              autoCompact: { enabled: false },
              tools: optChatTools(options.memory, options.bash, options.webSearch),
              hooks: {
                preRequest: [
                  {
                    name: 'OptChat.frozenView',
                    handler: (input) =>
                      Effect.gen(function* () {
                        yield* options.beforeRequest.pipe(Effect.orDie)
                        requestStart ??= input.prompt.content.findIndex(
                          (message) => message.role === 'user',
                        )
                        if (requestStart < 0)
                          throw new Error('Current input is missing from the agent request.')
                        return {
                          _tag: 'changed' as const,
                          prompt: Prompt.make([
                            { role: 'system', content: options.systemPrompt },
                            ...cachePrompt(
                              options.view,
                              input.prompt.content.slice(requestStart).map((message) => {
                                if (message.role !== 'user') return message
                                const text = message.content
                                  .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                                  .join('')
                                const images = imageInputs.get(text) ?? []
                                return Prompt.userMessage({
                                  options: message.options,
                                  content: [
                                    ...message.content,
                                    ...images.map((image) =>
                                      Prompt.filePart({
                                        mediaType: image.mimeType,
                                        data: Buffer.from(image.data, 'base64'),
                                      }),
                                    ),
                                  ],
                                })
                              }),
                            ).content,
                          ]),
                        }
                      }),
                  },
                ],
              },
            }),
            log: log ?? { _tag: 'memory' },
            steering: 'one-at-a-time',
          })
          return {
            send: Effect.fn('FoldRuntime.send')(function* (
              text: string,
              images: readonly AgentImage[] = [],
            ) {
              imageInputs.set(text, images)
              const result = yield* session
                .send(text)
                .pipe(
                  Effect.mapError(() => failure('The provider could not complete the response.')),
                )
              if (result.outcome === 'error')
                return yield* failure('The provider could not complete the response.')
              return result.resultText ?? ''
            }),
            steer: (text: string, images: readonly AgentImage[] = []) =>
              Effect.sync(() => imageInputs.set(text, images)).pipe(
                Effect.andThen(session.steer(text)),
                Effect.as(true),
                Effect.catchTag('AgentNotRunningError', () => Effect.succeed(false)),
                Effect.mapError(() => failure('Could not steer the response.')),
              ),
          }
        },
        (effect) => effect.pipe(Effect.mapError(() => failure('Could not start the Fold agent.'))),
      ),
    })
  }),
)
