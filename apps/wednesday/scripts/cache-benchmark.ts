// Run with a credential on stdin; all chat and memory state lives in a disposable database.
import { randomBytes } from 'node:crypto'
import { Prompt } from 'effect/ai'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteClient } from '@effect/sql-sqlite-bun'
import { ConfigProvider, Effect, Fiber, Layer, Redacted, Schedule, Schema, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { SqlClient } from 'effect/sql'
import { Chat, chatLayer } from '../src/server/Chat.ts'
import { ChatGpt, chatGptLayer } from '../src/server/ChatGpt.ts'
import { Credentials, credentialsLayer, defaultMapping } from '../src/server/Providers.ts'
import { sqliteMigrations, sqliteStorage } from '../src/server/SqliteStorage.ts'
import { WednesdayError } from '../src/server/errors.ts'
import { ApiFormat } from '../src/shared/protocol.ts'
import { MemoryState, Storage, StoredSettings } from '../src/server/Storage.ts'
import { failure } from '../src/server/errors.ts'

const Detail = Schema.Struct({ cached_tokens: Schema.optionalKey(Schema.Finite) })
const Usage = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.Finite),
  prompt_tokens: Schema.optionalKey(Schema.Finite),
  output_tokens: Schema.optionalKey(Schema.Finite),
  completion_tokens: Schema.optionalKey(Schema.Finite),
  input_tokens_details: Schema.optionalKey(Detail),
  prompt_tokens_details: Schema.optionalKey(Detail),
})
const Event = Schema.Struct({
  usage: Schema.optionalKey(Schema.NullOr(Usage)),
  response: Schema.optionalKey(Schema.Struct({ usage: Schema.optionalKey(Schema.NullOr(Usage)) })),
})
const Content = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
])
const WireMessage = Schema.Struct({ content: Schema.optionalKey(Schema.NullOr(Content)) })
const Request = Schema.Struct({
  prompt_cache_key: Schema.optionalKey(Schema.String),
  messages: Schema.optionalKey(Schema.Array(WireMessage)),
  input: Schema.optionalKey(Schema.Array(WireMessage)),
  model: Schema.String,
  tools: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Event))
const encodeMemory = Schema.encodeSync(Schema.fromJsonString(MemoryState))
const isString = Schema.is(Schema.String)
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request))
const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSettings))
const decodeExpiry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ expiresAt: Schema.Number })),
)
const decodeRejection = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optionalKey(
        Schema.Struct({
          code: Schema.optionalKey(Schema.String),
          type: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
)
const decodeWire = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)
const jsonArray = Schema.is(Schema.Array(Schema.Json))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const chatGptSource = Bun.argv[3] === 'chatgpt'
const format = Schema.decodeUnknownSync(ApiFormat)(
  chatGptSource ? 'responses' : (Bun.argv[3] ?? 'chat-completions'),
)
if (format === 'anthropic') throw new Error('This CPA benchmark supports the two OpenAI formats.')
const modelId = Bun.argv[2] ?? 'gpt-6.1-sol'
const userId = `cache-benchmark-${randomBytes(8).toString('hex')}`
const apiKey = (await Bun.stdin.text()).trim()
if (!apiKey) throw new Error('Provide a provider credential on stdin.')
type Measurement = {
  purpose: 'chat' | 'memory'
  turn: number
  step: number
  steeringMessages: number
  status: number
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
}
// Read provider fields directly so missing cache usage remains unknown rather than zero.
const readUsage = (text: string) => {
  let usage: typeof Usage.Type | undefined
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    const event = decodeEvent(data)
    usage = event.response?.usage ?? event.usage ?? usage
  }
  return usage
}
const usageMeasurement = (
  text: string,
  purpose: Measurement['purpose'],
  turn: number,
  step: number,
  steeringMessages: number,
  status: number,
): Measurement => {
  const usage = readUsage(text)
  return {
    purpose,
    turn,
    step,
    steeringMessages,
    status,
    inputTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? null,
    cachedTokens:
      usage?.input_tokens_details?.cached_tokens ??
      usage?.prompt_tokens_details?.cached_tokens ??
      null,
    outputTokens: usage?.output_tokens ?? usage?.completion_tokens ?? null,
  }
}
const measurements: Measurement[] = []
const pending: Promise<void>[] = []
let measurementFailed = false
const chatSteps = new Map<number, number>()
const previousPrompts = new Map<number, { messages: readonly string[]; settings: string }>()
const credentialsSeen = new Map<string, number>()
let replayStarted = false
const steeringTexts = [
  'Steering update A: continue the remaining tool steps in order, then also call date(3) before your final answer.',
  'Steering update B: continue all remaining tool steps; make your final answer two sentences and include the timestamps of messages 0 and 3.',
]
const requiredTools = [
  ...[16, 8, 4, 2, 1].map((n) => `zoom(${JSON.stringify({ id: 0, n })})`),
  'date({"id":0})',
  'date({"id":3})',
]
const summarize = (calls: readonly Measurement[]) => {
  const known = calls.filter((row) => row.inputTokens !== null && row.cachedTokens !== null)
  const inputTokens = known.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0)
  const cachedTokens = known.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0)
  return {
    calls: calls.length,
    unknownCalls: calls.length - known.length,
    inputTokens,
    cachedTokens,
    hitRate: inputTokens ? cachedTokens / inputTokens : null,
  }
}
let turn = 0
const recordPrefix = Effect.fn('Benchmark.recordPrefix')(function* (
  body: string,
  currentTurn: number,
  step: number,
) {
  const wire = decodeWire(body)
  const inputMessages = wire.messages ?? wire.input
  const messages = jsonArray(inputMessages)
    ? inputMessages.map((message) => encodeJson(message))
    : []
  const settings = encodeJson(
    Object.fromEntries(
      Object.entries(wire).filter(([name]) => name !== 'messages' && name !== 'input'),
    ),
  )
  const previous = previousPrompts.get(currentTurn)
  let sharedMessages = 0
  while (
    previous &&
    sharedMessages < previous.messages.length &&
    previous.messages[sharedMessages] === messages[sharedMessages]
  )
    sharedMessages++
  yield* Effect.logInfo({
    event: 'prompt-prefix',
    turn: currentTurn,
    step,
    previousMessages: previous?.messages.length ?? 0,
    sharedMessages,
    prefixPreserved: previous ? sharedMessages === previous.messages.length : null,
    settingsPreserved: previous ? settings === previous.settings : null,
  })
  previousPrompts.set(currentTurn, { messages, settings })
})
const recordRoute = Effect.fn('Benchmark.recordRoute')(function* (
  response: Response,
  purpose: Measurement['purpose'],
  currentTurn: number,
  step: number,
) {
  const authIndex = response.headers.get('X-CPA-TRACE-ID')?.match(/^\d{14}-([0-9a-f]{16})-/)?.[1]
  if (authIndex && !credentialsSeen.has(authIndex))
    credentialsSeen.set(authIndex, credentialsSeen.size + 1)
  yield* Effect.logInfo({
    event: 'provider-route',
    purpose,
    turn: currentTurn,
    step,
    credential: authIndex ? credentialsSeen.get(authIndex) : null,
  })
})
const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  isString(input) ? input : input instanceof URL ? input.href : input.url
const benchmarkTransport = (body: string, init?: Parameters<typeof fetch>[1]) =>
  Bun.argv[5] === 'cache-key' && format === 'chat-completions'
    ? { ...init, body: encodeJson({ ...decodeWire(body), prompt_cache_key: userId }) }
    : init
const measuredFetch: typeof globalThis.fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = isString(init?.body)
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : undefined
    if (body === undefined) return fetch(input, init)
    const url = requestUrl(input)
    if (chatGptSource && !url.endsWith('/responses')) return fetch(input, init)
    const request = decodeRequest(body)
    const requestText = [...(request.messages ?? []), ...(request.input ?? [])].flatMap(
      (message) =>
        isString(message.content)
          ? [message.content]
          : (message.content ?? []).flatMap((part) => (part.text ? [part.text] : [])),
    )
    const purpose = requestText.some((part) => part.startsWith('Compaction:')) ? 'memory' : 'chat'
    if (
      new Headers(init?.headers).get('Session-Id') !== userId ||
      (format === 'responses' && request.prompt_cache_key !== userId)
    )
      throw new Error('The provider request lost its stable user identity.')
    const currentTurn = turn
    const step = purpose === 'chat' ? (chatSteps.get(currentTurn) ?? 0) + 1 : 0
    if (purpose === 'chat') chatSteps.set(currentTurn, step)
    const steeringMessages = steeringTexts.filter((text) => requestText.includes(text)).length
    if (purpose === 'chat') await Effect.runPromise(recordPrefix(body, currentTurn, step))
    const transport = benchmarkTransport(body, init)
    const response = await fetch(input, transport)
    await Effect.runPromise(recordRoute(response, purpose, currentTurn, step))
    const copy = response.clone()
    pending.push(
      Effect.runPromise(
        Effect.gen(function* () {
          const text = yield* Effect.tryPromise(() => copy.text())
          if (response.status >= 400) {
            const rejection = decodeRejection(text)
            yield* Effect.logInfo({
              event: 'provider-rejected',
              status: response.status,
              details: rejection._tag === 'Some' ? rejection.value : null,
            })
          }
          const row = usageMeasurement(
            text,
            purpose,
            currentTurn,
            step,
            steeringMessages,
            response.status,
          )
          measurements.push(row)
          yield* Effect.logInfo({ event: 'model-usage', ...row })
          if (
            Bun.argv[6] === 'replay' &&
            purpose === 'chat' &&
            step > 1 &&
            row.cachedTokens === 0 &&
            !replayStarted
          ) {
            replayStarted = true
            for (const delayMillis of [0, 2000]) {
              yield* Effect.sleep(delayMillis)
              const replay = yield* Effect.tryPromise(() =>
                fetch(input, { ...transport, signal: null }),
              )
              const result = yield* Effect.tryPromise(() => replay.text())
              yield* Effect.logInfo({
                event: 'identical-replay',
                delayMillis,
                ...usageMeasurement(
                  result,
                  purpose,
                  currentTurn,
                  step,
                  steeringMessages,
                  replay.status,
                ),
              })
            }
          }
        }).pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              measurementFailed = true
              yield* Effect.logError('Could not measure or replay the provider response.')
            }),
          ),
        ),
      ),
    )
    return response
  },
  { preconnect: fetch.preconnect },
)
const program = Effect.acquireUseRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), 'friday-cache-'))),
  (directory) =>
    Effect.gen(function* () {
      const database = SqliteClient.layer({ filename: join(directory, 'benchmark.sqlite') })
      const migrations = sqliteMigrations.pipe(Layer.provide(database))
      const storage = sqliteStorage.pipe(Layer.provide(migrations), Layer.provide(database))
      const credentials = credentialsLayer
      const chatGpt = chatGptLayer.pipe(Layer.provide(storage), Layer.provide(credentials))
      const services = Layer.merge(
        chatLayer.pipe(Layer.provide(chatGpt), Layer.provide(storage), Layer.provide(credentials)),
        Layer.merge(chatGpt, Layer.merge(database, Layer.merge(storage, credentials))),
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              WEDNESDAY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
            }),
          ),
        ),
      )
      yield* Effect.gen(function* () {
        const chat = yield* Chat
        const sql = yield* SqlClient.SqlClient
        const stored = yield* Storage
        const saved = chatGptSource ? yield* decodeSaved(apiKey) : null
        const chosen =
          saved?.settings.models.find((model) => model.id === modelId) ??
          defaultMapping(modelId, format)
        const mapping = { ...chosen, maxOutputTokens: 1024 }
        if (saved) {
          const environment = yield* Effect.tryPromise(() =>
            readFile('/home/chanyeinthaw/.config/wednesday/development.env', 'utf8'),
          )
          const decrypted = yield* Effect.gen(function* () {
            const source = yield* Credentials
            return yield* source.decrypt(saved.encryptedKey)
          }).pipe(
            Effect.provide(Layer.fresh(credentialsLayer)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromDotEnvContents(environment))),
          )
          const expires = yield* decodeExpiry(Redacted.value(decrypted))
          if (expires.expiresAt <= Date.now() + 300_000)
            return yield* failure(
              'The saved ChatGPT access token needs refreshing before this isolated benchmark.',
            )
          const local = yield* Credentials
          yield* stored.saveSettings(userId, {
            settings: {
              ...saved.settings,
              modelId,
              memoryModelId: modelId,
              thinking: 'low',
              memoryThinking: 'low',
              models: [mapping],
            },
            encryptedKey: yield* local.encrypt(Redacted.value(decrypted)),
          })
          yield* Effect.logInfo({
            event: 'chatgpt-connection-ready',
            modelId,
            tokenValidMinutes: Math.floor((expires.expiresAt - Date.now()) / 60000),
          })
          if (Bun.argv[5] === 'probe') {
            const connection = yield* ChatGpt
            const model = yield* connection.model(userId, mapping, 'low').make
            yield* model.generateText({
              prompt: Prompt.make([{ role: 'user', content: 'Reply only OK.' }]),
            })
            yield* Effect.promise(() => Promise.all(pending))
            return
          }
        } else
          yield* chat.handle(userId, {
            _tag: 'SaveSettings',
            apiKey,
            settings: {
              provider: 'api',
              apiFormat: format,
              baseUrl: 'http://127.0.0.1:8320/v1',
              modelId,
              memoryModelId: modelId,
              thinking: 'low',
              memoryThinking: 'low',
              models: [mapping],
            },
          })
        // Real adapter jobs build the binary tree from a small, synthetic conversation.
        for (let id = 0; id < 16; id++) {
          const text = `Project decision ${id}: use email codes for sign-in, a private conversation per person, SQLite behind a storage interface, a light chat interface, and a short composer. Streaming reveals completed paragraphs. Model settings save automatically. Keep borders soft, put settings on their own page, and preserve user choices when switching providers.`
          const kind = id % 2 ? 'talk' : 'user'
          yield* sql`INSERT INTO wednesday_messages (user_id,id,kind,text,date) VALUES (${userId},${id},${kind},${text},${'2026-10-13T00:00:00.000Z'})`
          yield* sql`INSERT INTO wednesday_memory_jobs (user_id,id,count,source) VALUES (${userId},${id},1,${`${kind}: ${text}`})`
        }
        const parts = Array.from({ length: 16 }, (_, id) => ({ id, count: 1 }))
        yield* sql`INSERT INTO wednesday_memory_views (user_id,payload) VALUES (${userId},${encodeMemory({ parts, pending: false, revision: 0, compactParts: [], compactPending: false, compactRevision: -1, total: 16, frontier: 0 })})`
        // Every turn traverses real OptChat memory through separate model/tool round trips.
        const prompts = Array.from(
          { length: Number(Bun.argv[4] ?? 3) },
          (_, index) =>
            `Memory audit ${index + 1}: use these tools in this exact order: zoom(0,16), zoom(0,8), zoom(0,4), zoom(0,2), zoom(0,1), date(0). Call only ONE tool per response and wait for its result before choosing the next call. Do not batch calls or skip a step even if you already know the answer. You may receive steering while working; apply it without restarting or skipping this sequence. After all required tool calls, report the original first decision and its timestamp briefly.`,
        )
        for (const [index, text] of prompts.entries()) {
          turn = index + 1
          const requestId = `benchmark-${turn}`
          const tools: string[] = []
          const consumedSteering = new Set<string>()
          let steeringSent = 0
          const events = yield* chat.subscribe(userId)
          const finished = yield* events.pipe(
            Stream.tap((event) =>
              Effect.gen(function* () {
                if (event._tag === 'Error') return yield* failure(event.message)
                if (event._tag === 'Discarded') return yield* failure('Steering was discarded.')
                if (event._tag !== 'Message') return
                if (
                  event.message.kind === 'user' &&
                  event.message.requestId?.startsWith(`${requestId}-steer-`)
                )
                  consumedSteering.add(event.message.requestId)
                if (event.message.kind !== 'tool') return
                tools.push(event.message.text)
                yield* Effect.logInfo({ event: 'tool-called', turn, tool: event.message.text })
                if (tools.length !== 1 && tools.length !== 4) return
                const steering = steeringTexts[steeringSent]
                if (!steering) return
                steeringSent++
                yield* chat.handle(userId, {
                  _tag: 'Steer',
                  requestId: `${requestId}-steer-${steeringSent}`,
                  turnId: requestId,
                  text: steering,
                })
                yield* Effect.logInfo({ event: 'steering-sent', turn, afterTool: tools.length })
              }),
            ),
            Stream.filter((event) => event._tag === 'Status' && !event.busy),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          )
          yield* chat.handle(userId, { _tag: 'Send', requestId, text })
          yield* Fiber.join(finished).pipe(Effect.timeout('3 minutes'))
          yield* Effect.promise(() => Promise.all(pending))
          const calls = measurements.filter((row) => row.purpose === 'chat' && row.turn === turn)
          if (
            calls.length < 8 ||
            !requiredTools.every((tool, index) => tools[index] === tool) ||
            consumedSteering.size !== 2 ||
            !calls.some((row) => row.steeringMessages === 2)
          )
            return yield* failure(
              'Turn did not complete the multi-step tool and steering workload.',
            )
          yield* Effect.logInfo({
            event: 'turn-finished',
            turn,
            toolCalls: tools.length,
            consumedSteering: consumedSteering.size,
            firstRequest: summarize(calls.filter((row) => row.step === 1)),
            inTurnFollowups: summarize(calls.filter((row) => row.step > 1)),
          })
        }
        yield* sql<{
          count: number
          failed: number
        }>`SELECT COUNT(*) AS count,SUM(status='failed') AS failed FROM wednesday_memory_jobs`.pipe(
          Effect.flatMap((rows) =>
            rows[0]?.failed ? failure('Memory job failed') : Effect.succeed(rows[0]?.count ?? 0),
          ),
          Effect.repeat({ schedule: Schedule.spaced('250 millis'), while: (count) => count > 0 }),
          Effect.timeout('3 minutes'),
        )
        yield* Effect.promise(() => Promise.all(pending))
        if (measurementFailed) return yield* failure('Provider usage measurement failed.')
        const chatCalls = measurements.filter((row) => row.purpose === 'chat')
        const groups = {
          'chat-first-requests': chatCalls.filter((row) => row.step === 1),
          'chat-in-turn-followups': chatCalls.filter((row) => row.step > 1),
          'chat-warm-in-turn-followups': chatCalls.filter((row) => row.step > 1 && row.turn > 1),
          'chat-followups-before-steering': chatCalls.filter(
            (row) => row.step > 1 && row.steeringMessages === 0,
          ),
          'chat-followups-with-steering': chatCalls.filter(
            (row) => row.step > 1 && row.steeringMessages > 0,
          ),
          'chat-all': chatCalls,
          'memory-all': measurements.filter((row) => row.purpose === 'memory'),
        }
        for (const [group, calls] of Object.entries(groups)) {
          yield* Effect.logInfo({
            event: 'summary',
            group,
            format,
            provider: chatGptSource ? 'chatgpt' : 'cpa',
            modelId,
            cacheKeyOverride: Bun.argv[5] === 'cache-key',
            diagnosticReplay: Bun.argv[6] === 'replay',
            ...summarize(calls),
          })
        }
      }).pipe(
        Effect.provide(services),
        Effect.provideService(FetchHttpClient.Fetch, measuredFetch),
        Effect.scoped,
      )
    }),
  (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
)
await Effect.runPromise(
  program.pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logError(
          error instanceof WednesdayError
            ? error.message
            : error instanceof Error &&
                error.message === 'The provider request lost its stable user identity.'
              ? error.message
              : 'Cache benchmark failed before completion.',
        )
        process.exitCode = 1
      }),
    ),
  ),
)
