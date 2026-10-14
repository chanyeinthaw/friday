import { webSearchDescription } from './Firecrawl.ts'
import { Config, Effect, Layer, Redacted, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { Prompt } from 'effect/ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  lazyStream,
  Type,
  type Api,
} from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { closeOpenAICodexWebSocketSessions } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { AgentId, MessageId, ToolCallId, LogEntryInput } from '@humanlayer/fold-core'
import { AgentRuntime, type AgentImage } from './AgentRuntime.ts'
import { cachePrompt } from './CachePrompt.ts'
import { failure } from './errors.ts'

const decodeEntry = Schema.decodeUnknownEffect(LogEntryInput)
const encodeUser = Schema.encodeSync(Prompt.UserMessage)
const encodeAssistant = Schema.encodeSync(Prompt.AssistantMessage)
const encodeTool = Schema.encodeSync(Prompt.ToolMessage)
const isString = Schema.is(Schema.String)
const decodeFields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))
// Only fixed messages cross the provider boundary; upstream errors can contain request data.
const systemFailure = () =>
  failure('The provider could not complete the response. Please try again.')
const providerFailure = (message: string) => {
  if (/usage_limit_reached|usage limit/i.test(message))
    return failure('Your provider usage limit has been reached. Please try again later.')
  if (/rate_limit|rate limit|too many requests/i.test(message))
    return failure('Your provider is busy. Please try again shortly.')
  if (/image.*(?:too large|invalid|unsupported)|(?:invalid|unsupported).*image/i.test(message))
    return failure('The provider could not read this image. Try a smaller PNG or JPEG.')
  if (/unsupported value.*(?:none|effort)|reasoning.*not supported/i.test(message))
    return failure(
      'This model does not support the selected effort. Choose another effort in Settings.',
    )
  if (/expired.*token|invalid_api_key|unauthorized|authentication/i.test(message))
    return failure('Your provider connection has expired. Reconnect in Settings.')
  return systemFailure()
}

export const piRuntimeLayer = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const providerFetch = yield* FetchHttpClient.Fetch
    const chatGptTransport = yield* Config.Literals(
      ['websocket', 'sse'],
      'WEDNESDAY_PI_CHATGPT_TRANSPORT',
    ).pipe(Config.withDefault('websocket'))
    const backend = yield* Config.String('WEDNESDAY_CHATGPT_BACKEND').pipe(
      Config.withDefault('https://chatgpt.com/backend-api/codex'),
    )
    return AgentRuntime.of({
      open: Effect.fn('PiRuntime.open')(function* (options) {
        const { connection } = options
        const { settings, mapping, thinking, cacheKey } = connection
        const chatGpt = settings.provider === 'chatgpt'
        const api: Api = chatGpt
          ? 'openai-codex-responses'
          : settings.apiFormat === 'anthropic'
            ? 'anthropic-messages'
            : settings.apiFormat === 'responses'
              ? 'openai-responses'
              : 'openai-completions'
        const fields = { ...mapping.requestFields, ...mapping.thinking[thinking] }
        const credential = yield* connection.credential
        const runtime = yield* Effect.tryPromise({
          try: () =>
            ModelRuntime.create({
              credentials: new InMemoryCredentialStore(),
              modelsStore: new InMemoryModelsStore(),
              modelsPath: null,
              refreshOnCreate: false,
              allowModelNetwork: false,
            }),
          catch: systemFailure,
        })
        let work = Promise.resolve()
        let failed = false
        let providerError: ReturnType<typeof failure> | undefined
        const lastProviderError = () => providerError
        const enqueue = <A, E>(effect: Effect.Effect<A, E>) => {
          work = work
            .then(() => Effect.runPromise(effect))
            .then(
              () => undefined,
              () => {
                failed = true
              },
            )
        }
        const beforeRequest = async (signal?: AbortSignal) => {
          await work
          if (failed) throw systemFailure()
          await Effect.runPromise(options.beforeRequest, signal ? { signal } : undefined)
        }
        runtime.registerProvider('friday', {
          api,
          apiKey: Redacted.value(credential.apiKey),
          models: [
            {
              id: mapping.id,
              name: mapping.displayName ?? mapping.id,
              api,
              baseUrl: chatGpt
                ? backend
                : api === 'anthropic-messages'
                  ? settings.baseUrl.replace(/\/v1\/?$/, '')
                  : settings.baseUrl,
              input: ['text', 'image'],
              reasoning: Object.keys(mapping.thinking).some((level) => level !== 'off'),
              contextWindow: mapping.contextWindow,
              maxTokens: mapping.maxOutputTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
          streamSimple: (model, context, requestOptions) =>
            lazyStream(model, async () => {
              await beforeRequest(requestOptions?.signal)
              const access = await Effect.runPromise(
                connection.credential,
                requestOptions?.signal ? { signal: requestOptions.signal } : undefined,
              )
              const first = context.messages.findIndex((message) => message.role === 'user')
              const initial = first >= 0 ? context.messages[first] : undefined
              const text =
                initial?.role === 'user'
                  ? isString(initial.content)
                    ? initial.content
                    : initial.content
                        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                        .join('')
                  : ''
              const frozen = cachePrompt(options.view, [
                Prompt.userMessage({ content: [Prompt.textPart({ text })] }),
              ]).content[0]
              const blocks =
                frozen?.role === 'user'
                  ? frozen.content.flatMap((part) =>
                      part.type === 'text' ? [{ type: 'text' as const, text: part.text }] : [],
                    )
                  : []
              const messages = context.messages.map((message, index) =>
                index === first && message.role === 'user'
                  ? {
                      ...message,
                      content: [
                        ...blocks,
                        ...(isString(message.content)
                          ? []
                          : message.content.filter((part) => part.type === 'image')),
                      ],
                    }
                  : message,
              )
              const headers = Object.fromEntries(
                Object.entries(requestOptions?.headers ?? {}).flatMap(([name, value]) =>
                  isString(value) ? [[name, value]] : [],
                ),
              )
              headers['Session-Id'] = cacheKey
              if (access.accountId) headers['ChatGPT-Account-Id'] = access.accountId
              return streamSimple(
                model,
                { ...context, messages },
                {
                  ...requestOptions,
                  apiKey: Redacted.value(access.apiKey),
                  sessionId: cacheKey,
                  transport: chatGpt && connection.purpose === 'chat' ? chatGptTransport : 'sse',
                  fetch: providerFetch,
                  maxTokens: mapping.maxOutputTokens,
                  maxRetries: 0,
                  headers,
                  onPayload: async (payload, selected) => {
                    const transformed = await requestOptions?.onPayload?.(payload, selected)
                    const body = decodeFields(transformed ?? payload)
                    const configured = { ...body, ...fields }
                    if (api === 'openai-responses' || api === 'openai-codex-responses') {
                      configured.prompt_cache_key = cacheKey
                      configured.store = false
                    } else if (
                      api === 'openai-completions' &&
                      /^(gpt-|o[134](?:-|$)|codex-)/.test(mapping.id)
                    )
                      configured.prompt_cache_key = cacheKey
                    return configured
                  },
                },
              )
            }),
        })
        const model = runtime.getModel('friday', mapping.id)
        if (!model) return yield* systemFailure()
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false, provider: { maxRetries: 0 } },
          cacheWarming: 'off',
          // Preserve supported uploads without native image-resizing modules in the compiled binary.
          images: { autoResize: false },
          enableAnalytics: false,
          enableInstallTelemetry: false,
          enableSkillCommands: false,
          steeringMode: 'one-at-a-time',
        })
        const resourceLoader = new DefaultResourceLoader({
          cwd: '/',
          agentDir: '/',
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: options.systemPrompt,
          extensionFactories: [
            (pi) => {
              pi.on('before_agent_start', () => ({ systemPrompt: options.systemPrompt }))
            },
          ],
        })
        yield* Effect.tryPromise({ try: () => resourceLoader.reload(), catch: systemFailure })
        const drainBeforeTool = async () => {
          await work
          if (failed) throw systemFailure()
        }
        const created = yield* Effect.tryPromise({
          try: () =>
            createAgentSession({
              cwd: '/',
              agentDir: '/',
              modelRuntime: runtime,
              model,
              thinkingLevel: thinking,
              sessionManager: SessionManager.inMemory('/'),
              settingsManager,
              resourceLoader,
              tools: [
                'zoom',
                'date',
                ...(options.bash ? ['bash'] : []),
                ...(options.webSearch ? ['web_search'] : []),
              ],
              customTools: [
                ...(options.webSearch
                  ? [
                      {
                        name: 'web_search',
                        label: 'Web search',
                        description: webSearchDescription,
                        parameters: Type.Object({
                          query: Type.String({ minLength: 1, maxLength: 500 }),
                        }),
                        execute: async (
                          _id: string,
                          { query }: { query: string },
                          signal?: AbortSignal,
                        ) => {
                          await drainBeforeTool()
                          const text = await Effect.runPromise(
                            options.webSearch
                              ? options.webSearch(query)
                              : Effect.succeed('Web search unavailable.'),
                            signal ? { signal } : undefined,
                          )
                          return { content: [{ type: 'text' as const, text }], details: undefined }
                        },
                      },
                    ]
                  : []),
                ...(options.bash
                  ? [
                      {
                        name: 'bash',
                        label: 'bash',
                        description:
                          'Run shell commands in a private virtual filesystem. /attachments is read-only; /tmp is writable for this turn. Use ls, rg, sed, awk and jq to inspect files. No network or host access.',
                        parameters: Type.Object({ command: Type.String() }),
                        execute: async (
                          _id: string,
                          { command }: { command: string },
                          signal?: AbortSignal,
                        ) => {
                          await drainBeforeTool()
                          const text = await Effect.runPromise(
                            options.bash
                              ? options.bash(command)
                              : Effect.succeed('Bash unavailable.'),
                            signal ? { signal } : undefined,
                          )
                          return { content: [{ type: 'text' as const, text }], details: undefined }
                        },
                      },
                    ]
                  : []),
                {
                  name: 'zoom',
                  label: 'zoom',
                  description:
                    'Open an aligned summary range into its children, or retrieve one original message.',
                  parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
                  execute: async (_id, { id, n }, signal) => {
                    await drainBeforeTool()
                    const text = await Effect.runPromise(
                      options.memory.zoom(id, n),
                      signal ? { signal } : undefined,
                    )
                    return { content: [{ type: 'text', text }], details: undefined }
                  },
                },
                {
                  name: 'date',
                  label: 'date',
                  description: 'Return the timestamp of an original message.',
                  parameters: Type.Object({ id: Type.Integer() }),
                  execute: async (_id, { id }, signal) => {
                    await drainBeforeTool()
                    const text = await Effect.runPromise(
                      options.memory.date(id),
                      signal ? { signal } : undefined,
                    )
                    return { content: [{ type: 'text', text }], details: undefined }
                  },
                },
              ],
            }),
          catch: systemFailure,
        })
        const toolIds = new Map<string, ToolCallId>()
        const logToolId = (nativeId: string) => {
          const existing = toolIds.get(nativeId)
          if (existing) return existing
          const id = ToolCallId.create()
          toolIds.set(nativeId, id)
          return id
        }
        const agentId = AgentId.create()
        const append = options.append
        const onText = options.onText
        const handle = (event: AgentSessionEvent) => {
          if (
            event.type === 'message_update' &&
            event.assistantMessageEvent.type === 'text_delta' &&
            onText
          ) {
            const part = event.assistantMessageEvent
            enqueue(onText({ id: String(part.contentIndex), delta: part.delta }))
          }
          if (event.type !== 'message_end') return
          const message = event.message
          if (
            message.role === 'assistant' &&
            (message.stopReason === 'error' || message.stopReason === 'aborted')
          )
            providerError = providerFailure(message.errorMessage ?? '')
          if (!append) return
          const envelope = {
            agentId,
            parentAgentId: null,
            toolCallId: null,
            messageId: MessageId.create(),
          }
          if (message.role === 'user') {
            const content = isString(message.content)
              ? [Prompt.textPart({ text: message.content })]
              : message.content.flatMap((part) =>
                  part.type === 'text' ? [Prompt.textPart({ text: part.text })] : [],
                )
            enqueue(
              decodeEntry({
                ...envelope,
                _tag: 'user-message',
                message: encodeUser(Prompt.userMessage({ content })),
              }).pipe(Effect.flatMap(append)),
            )
          } else if (message.role === 'assistant') {
            // Native reasoning stays in Pi's active session, never in user-visible storage.
            const content = message.content.flatMap<Prompt.AssistantMessage['content'][number]>(
              (part) => {
                if (part.type === 'text') return [Prompt.textPart({ text: part.text })]
                if (part.type === 'toolCall')
                  return [
                    Prompt.toolCallPart({
                      id: logToolId(part.id),
                      name: part.name,
                      params: part.arguments,
                      providerExecuted: false,
                    }),
                  ]
                return []
              },
            )
            enqueue(
              decodeEntry({
                ...envelope,
                _tag: 'assistant-message',
                message: encodeAssistant(Prompt.assistantMessage({ content })),
                finish: null,
              }).pipe(Effect.flatMap(append)),
            )
          } else if (message.role === 'toolResult') {
            const result = message.content
              .flatMap((part) => (part.type === 'text' ? [part.text] : []))
              .join('\n')
            enqueue(
              decodeEntry({
                ...envelope,
                toolCallId: logToolId(message.toolCallId),
                _tag: 'tool-result',
                message: encodeTool(
                  Prompt.toolMessage({
                    content: [
                      Prompt.toolResultPart({
                        id: logToolId(message.toolCallId),
                        name: message.toolName,
                        result,
                        isFailure: message.isError,
                        providerExecuted: false,
                      }),
                    ],
                  }),
                ),
              }).pipe(Effect.flatMap(append)),
            )
          }
        }
        const unsubscribe = created.session.subscribe(handle)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.promise(() => created.session.abort())
            yield* Effect.promise(() => work)
            unsubscribe()
            created.session.dispose()
            closeOpenAICodexWebSocketSessions(cacheKey)
          }),
        )
        return {
          send: Effect.fn('PiRuntime.send')(function* (
            text: string,
            images: readonly AgentImage[] = [],
          ) {
            providerError = undefined
            yield* Effect.tryPromise({
              try: () =>
                created.session.prompt(text, { expandPromptTemplates: false, images: [...images] }),
              catch: systemFailure,
            })
            yield* Effect.promise(() => work)
            if (failed) return yield* systemFailure()
            const error = lastProviderError()
            if (error) return yield* error
            return created.session.getLastAssistantText() ?? ''
          }),
          steer: Effect.fn('PiRuntime.steer')((text: string, images: readonly AgentImage[] = []) =>
            Effect.gen(function* () {
              if (!created.session.isStreaming) return false
              yield* Effect.tryPromise({
                try: () => created.session.steer(text, [...images]),
                catch: systemFailure,
              })
              return true
            }),
          ),
        }
      }),
    })
  }),
)
