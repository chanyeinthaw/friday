// Pipe the saved encrypted development credential here; all benchmark state is disposable.
// Arguments: model, turns, websocket|websocket-cached|sse, optional cli for real memory hooks.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createModels } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import {
  closeOpenAICodexWebSocketSessions,
  getOpenAICodexWebSocketDebugStats,
} from '@earendil-works/pi-ai/api/openai-codex-responses'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import {
  createToolRegistry,
  openHarness,
  piOperation,
  PiDurableError,
} from '@friday/pi-durable-effect'
import { makePiSqliteStorage } from '@friday/pi-durable-effect/sqlite'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import { Clock, ConfigProvider, Effect, Redacted, Schedule, Schema, Stream } from 'effect'
import { ModelSelection } from '@friday/contracts/conversation'
import { SqlClient } from 'effect/sql'
import { Credentials, credentialsLayer } from '../../wednesday/src/server/Providers.ts'
import { StoredSettings } from '../../wednesday/src/server/Storage.ts'
import { instructions } from '../../wednesday/src/server/OptChat.ts'
import { makeOptChatMemory } from '../src/optchat/OptChatMemory.ts'
import { makeOptChatTools } from '../src/optchat/OptChatTools.ts'
import { makeOptChatHarness } from '../src/optchat/OptChatHarness.ts'
import { makeOptChatCompressor } from '../src/optchat/OptChatCompactor.ts'
import type { Harness } from '@earendil-works/pi-durable'
import { splitOptChatView, withOptChatCache } from '../src/optchat/OptChatCache.ts'
import { nodeKey, renderView, type MemoryNode } from '../src/optchat/OptChatTree.ts'
import { failure } from '../../wednesday/src/server/errors.ts'

const decodeSaved = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSettings))
const decodeTokens = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ accessToken: Schema.String, expiresAt: Schema.Finite })),
)
const isTaggedError = Schema.is(Schema.Struct({ _tag: Schema.String }))
const isString = Schema.is(Schema.String)
const decodeToolParameters = Schema.decodeUnknownSync(
  Schema.Struct({ id: Schema.Finite, n: Schema.optionalKey(Schema.Finite) }),
)
const Transport = Schema.Literals(['websocket', 'websocket-cached', 'sse'])
const transport = Schema.decodeUnknownSync(Transport)(Bun.argv[4] ?? 'websocket')
const cpa = Bun.argv[6] === 'cpa'
const cliMemory = Bun.argv[5] === 'cli'
const encodeParts = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.Int, count: Schema.Int }))),
)
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection)
let stage = 'credential'
const source = await Bun.stdin.text()
const modelId = Bun.argv[2] ?? 'gpt-6.1-sol'
const turnCount = Number(Bun.argv[3] ?? 3)
const sessionId = randomUUID()
const rows: {
  purpose: 'chat' | 'memory'
  turn: number
  step: number
  inputTokens: number
  cachedTokens: number
}[] = []
const routes = new Map<string, number>()
const steering = [
  'Steering update A: continue the remaining tool steps in order, then also call date(3) before your final answer.',
  'Steering update B: continue all remaining tool steps; make your final answer two sentences and include the timestamps of messages 0 and 3.',
]
const summarize = (calls: typeof rows) => {
  const inputTokens = calls.reduce((sum, call) => sum + call.inputTokens, 0)
  const cachedTokens = calls.reduce((sum, call) => sum + call.cachedTokens, 0)
  return { calls: calls.length, inputTokens, cachedTokens, hitRate: cachedTokens / inputTokens }
}
const validateTurn = (
  calls: number,
  steered: number,
  toolSequence: readonly string[],
  measured: typeof rows,
) =>
  Effect.gen(function* () {
    if (calls !== 7 || steered !== 2)
      return yield* failure(
        `Pi completed ${calls} tool calls and consumed ${steered} active steering messages.`,
      )
    const expected = [
      'zoom:0:16',
      'zoom:0:8',
      'zoom:0:4',
      'zoom:0:2',
      'zoom:0:1',
      'date:0',
      'date:3',
    ]
    if (!expected.every((tool, index) => toolSequence[index] === tool))
      return yield* failure('Pi did not follow the required tool sequence.')
    if (measured.length !== 8) return yield* failure('Missing Pi usage measurements.')
  })

await Effect.runPromise(
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp('/tmp/friday-pi-cache-')),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    )
    const apiKey = cpa
      ? source.trim()
      : yield* Effect.gen(function* () {
          const saved = yield* decodeSaved(source)
          const environment = yield* Effect.tryPromise(() =>
            readFile('/home/chanyeinthaw/.config/wednesday/development.env', 'utf8'),
          )
          const encrypted = yield* Effect.gen(function* () {
            return yield* (yield* Credentials).decrypt(saved.encryptedKey)
          }).pipe(
            Effect.provide(credentialsLayer),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromDotEnvContents(environment))),
          )
          const tokens = yield* decodeTokens(Redacted.value(encrypted))
          if (tokens.expiresAt <= (yield* Clock.currentTimeMillis) + 300_000)
            return yield* failure('Saved ChatGPT token needs refreshing.')
          return tokens.accessToken
        })
    if (!apiKey) return yield* failure('A provider credential is required.')
    let turn = 0
    let step = 0
    let calls = 0
    let toolSequence: string[] = []
    let steered = 0
    let rejected = false
    const models = createModels()
    stage = 'provider-model'
    const codex = openaiCodexProvider()
    const standard = openaiProvider()
    const provider = cpa ? standard : codex
    const codexModel = codex.getModels().find((candidate) => candidate.id === modelId)
    const standardModel = standard.getModels().find((candidate) => candidate.id === modelId)
    if (!codexModel || !standardModel)
      return yield* failure('The requested model is missing from the Pi catalog.')
    const cpaModel = {
      ...standardModel,
      baseUrl: Bun.env.FRIDAY_CACHE_BENCHMARK_URL ?? 'http://127.0.0.1:8320/v1',
    }
    const model = cpa ? cpaModel : codexModel
    if (!model) return yield* failure('The requested model is missing from the Pi Codex catalog.')
    models.setProvider({
      ...provider,
      auth: {
        apiKey: {
          name: 'Saved development connection',
          resolve: async () => ({
            auth: { apiKey: apiKey },
            source: 'Saved development connection',
          }),
        },
      },
      getModels: () => [model],
      streamSimple: (_selected, context, options) => {
        const purpose = context.messages.some(
          (message) =>
            message.role === 'user' &&
            (isString(message.content)
              ? message.content.includes('Compaction:')
              : message.content.some(
                  (part) => part.type === 'text' && part.text.startsWith('Compaction:'),
                )),
        )
          ? ('memory' as const)
          : ('chat' as const)
        if (purpose === 'chat') step++
        const current = { purpose, turn, step: purpose === 'chat' ? step : 0 }
        let route: number | undefined
        const consumed = context.messages.filter(
          (message) =>
            message.role === 'user' &&
            steering.some((text) =>
              isString(message.content)
                ? message.content === text
                : message.content.some((part) => part.type === 'text' && part.text === text),
            ),
        ).length
        if (purpose === 'chat') steered = Math.max(steered, consumed)
        const requestSession =
          purpose === 'memory' && Bun.env.FRIDAY_CACHE_BENCHMARK_MEMORY_SESSION === 'separate'
            ? `${sessionId}:memory`
            : sessionId
        const requestOptions = {
          ...options,
          apiKey: apiKey,
          sessionId: requestSession,
          transport: purpose === 'memory' ? ('sse' as const) : transport,
          headers: { ...options?.headers, 'Session-Id': requestSession },
          maxRetries: 0,
          maxTokens: 1024,
          onResponse: async (response: { status: number; headers: Record<string, string> }) => {
            const trace = Object.entries(response.headers).find(
              ([name]) => name.toLowerCase() === 'x-cpa-trace-id',
            )?.[1]
            const account = trace?.match(/^\d{14}-([0-9a-f]{16})-/)?.[1]
            if (account) {
              if (!routes.has(account)) routes.set(account, routes.size + 1)
              route = routes.get(account)
            }
            await options?.onResponse?.(response, model)
          },
        }
        const input = cpa
          ? standard.streamSimple(cpaModel, context, requestOptions)
          : codex.streamSimple(codexModel, context, requestOptions)
        const output = createAssistantMessageEventStream()
        void Effect.runPromise(
          Stream.fromAsyncIterable(input, () => 'Pi provider stream failed').pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type === 'done') {
                  const usage = event.message.usage
                  const row = {
                    ...current,
                    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
                    cachedTokens: usage.cacheRead,
                  }
                  rows.push(row)
                  yield* Effect.logInfo({ event: 'model-usage', ...row, route: route ?? null })
                }
                if (event.type === 'error') {
                  if (purpose === 'chat') rejected = true
                  const code =
                    [
                      'usage_limit_reached',
                      'server_is_overloaded',
                      'rate_limit_exceeded',
                      'previous_response_not_found',
                      'websocket_connection_limit_reached',
                      'invalid_request_error',
                      'invalid_api_key',
                      'authentication_error',
                      'model_not_found',
                    ].find((value) => event.error.errorMessage?.includes(value)) ??
                    (event.error.errorMessage?.includes('overloaded')
                      ? 'server_is_overloaded'
                      : 'unclassified')
                  yield* Effect.logWarning({
                    event: 'provider-rejected',
                    ...current,
                    code,
                    socketError: event.error.errorMessage?.includes('WebSocket') ?? false,
                    connectionLimit:
                      event.error.errorMessage?.includes('connection limit') ?? false,
                  })
                }
                output.push(event)
              }),
            ),
          ),
        ).then(undefined, () => output.end())
        return output
      },
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => closeOpenAICodexWebSocketSessions(sessionId)),
    )
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      stage = 'memory-fixture'
      const compress = cliMemory
        ? makeOptChatCompressor(
            models,
            () => ({
              ...decodeModelSelection({ provider: provider.id, modelId }),
              thinkingLevel: 'low',
            }),
            directory,
          )
        : () =>
            Effect.fail(
              new PiDurableError({
                operation: 'benchmark-compaction',
                cause: 'Unexpected compaction during fixed-fixture comparison.',
              }),
            )
      const memory = yield* makeOptChatMemory(compress)
      const nodes = new Map<string, MemoryNode>()
      for (let id = 0; id < 16; id++) {
        const text = `Project decision ${id}: use email codes for sign-in, a private conversation per person, SQLite behind a storage interface, a light chat interface, and a short composer. Streaming reveals completed paragraphs. Model settings save automatically. Keep borders soft, put settings on their own page, and preserve user choices when switching providers.`
        const kind = id % 2 ? 'talk' : 'user'
        yield* sql`INSERT INTO optchat_messages (memory_id,id,source_key,kind,text,date) VALUES (${sessionId},${id},${String(id)},${kind},${text},${'2026-10-13T00:00:00.000Z'})`
        yield* sql`INSERT INTO optchat_nodes (memory_id,id,count,text) VALUES (${sessionId},${id},1,${`${kind}: ${text}`})`
        const node = { id, count: 1, text: `${kind}: ${text}` }
        nodes.set(nodeKey(node), node)
      }
      for (const count of [2, 4, 8, 16])
        for (let id = 0; id < 16; id += count)
          yield* sql`INSERT INTO optchat_nodes (memory_id,id,count,text) VALUES (${sessionId},${id},${count},${`Decisions ${id} through ${id + count - 1}: email codes, private conversations, SQLite storage interfaces, light UI, short composer, paragraph streaming, automatic model settings, soft borders, and preserved provider choices.`})`
      const view = renderView(
        Array.from({ length: 16 }, (_, id) => ({ id, count: 1 })),
        nodes,
      )
      const parts = encodeParts(Array.from({ length: 16 }, (_, id) => ({ id, count: 1 })))
      yield* sql`INSERT INTO optchat_views (memory_id,parts) VALUES (${sessionId},${parts})`
      yield* sql`INSERT INTO optchat_progress (memory_id,complete_total) VALUES (${sessionId},16)`
      yield* sql`INSERT INTO optchat_cache_views (memory_id,pending,revision,compact_parts,compact_pending,compact_revision) VALUES (${sessionId},0,0,${parts},0,0)`
      stage = 'harness'
      const registry = createToolRegistry()
      let activeHarness: Harness | undefined
      const optChat = makeOptChatHarness(memory, () => {
        if (!activeHarness) throw new Error('Benchmark harness is not initialized.')
        return activeHarness
      })
      const tools = makeOptChatTools(memory, sessionId).map((tool) => ({
        ...tool,
        execute: async (...args: Parameters<typeof tool.execute>) => {
          const result = await tool.execute(...args)
          const parameters = decodeToolParameters(args[0])
          toolSequence.push(
            tool.name === 'zoom' && parameters.n !== undefined
              ? `zoom:${parameters.id}:${parameters.n}`
              : `date:${parameters.id}`,
          )
          calls++
          if (calls === 1 || calls === 4) {
            const [, _api, context] = args
            const handle = await _api.conversation(_api.conversationId, context)
            if (!handle) throw new Error('Benchmark conversation missing.')
            await handle.submit(
              {
                type: 'input',
                content: steering[calls === 1 ? 0 : 1] ?? '',
                whenBusy: 'steer',
                requestId: `steer-${turn}-${calls}`,
              },
              context,
            )
          }
          return result
        },
      }))
      const loadout = yield* registry.provide('cache-benchmark', {
        tools,
        systemPrompt: () => Effect.succeed(instructions),
        hooks: cliMemory ? optChat.hooks(sessionId) : [],
      })
      const harness = yield* openHarness(yield* makePiSqliteStorage(), {
        models: withOptChatCache(models),
        registry: registry.registry,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      })
      activeHarness = harness
      const conversation = yield* piOperation('create', (context) =>
        harness.createConversation(
          {
            ownership: { kind: 'ownerless' },
            agent: { ...loadout, model: { provider: provider.id, modelId }, thinkingLevel: 'low' },
          },
          context,
        ),
      )
      if (cliMemory) {
        yield* optChat.activate(conversation, sessionId)
        yield* memory
          .pump(sessionId)
          .pipe(Effect.repeat(Schedule.spaced('10 seconds')), Effect.forkScoped)
      }
      for (turn = 1; turn <= turnCount; turn++) {
        step = 0
        calls = 0
        toolSequence = []
        steered = 0
        if (turn > 1 && !cliMemory)
          yield* piOperation('reset', (context) => conversation.reset(undefined, context))
        const text = `Memory audit ${turn}: use these tools in this exact order: zoom(0,16), zoom(0,8), zoom(0,4), zoom(0,2), zoom(0,1), date(0). Call only ONE tool per response and wait for its result before choosing the next call. Do not batch calls or skip a step even if you already know the answer. You may receive steering while working; apply it without restarting or skipping this sequence. After all required tool calls, report the original first decision and its timestamp briefly.`
        stage = 'generation'
        yield* piOperation('submit', (context) =>
          conversation.submit(
            {
              type: 'input',
              content: (cliMemory ? [text] : [...splitOptChatView(view), `\n${text}`]).map(
                (piece) => ({
                  type: 'text',
                  text: piece,
                }),
              ),
              requestId: `turn-${turn}`,
            },
            context,
          ),
        )
        yield* piOperation('idle', (context) => conversation.waitForIdle(context))
        if (rejected) return yield* failure('Provider rejected a Pi benchmark request.')
        const measured = rows.filter((row) => row.purpose === 'chat' && row.turn === turn)
        yield* validateTurn(calls, steered, toolSequence, measured)
        yield* Effect.logInfo({
          event: 'turn-finished',
          turn,
          toolCalls: calls,
          consumedSteering: steered,
          firstRequest: summarize(measured.filter((row) => row.step === 1)),
          inTurnFollowups: summarize(measured.filter((row) => row.step > 1)),
        })
        if (cliMemory) {
          yield* optChat.sync(conversation, sessionId)
          yield* memory.pump(sessionId)
        }
      }
      yield* Effect.logInfo({
        event: 'summary',
        group: 'chat-in-turn-followups',
        harness: 'pi-durable',
        provider: cpa ? 'cpa-responses' : 'chatgpt',
        transport,
        memoryMode: cliMemory ? 'cli-hooks-and-compactor' : 'fixed-fixture',
        memorySession: Bun.env.FRIDAY_CACHE_BENCHMARK_MEMORY_SESSION ?? 'shared',
        ...summarize(rows.filter((row) => row.purpose === 'chat' && row.step > 1)),
      })
      const stats = getOpenAICodexWebSocketDebugStats(sessionId)
      if (stats)
        yield* Effect.logInfo({
          event: 'provider-socket',
          requests: stats.requests,
          connectionsCreated: stats.connectionsCreated,
          connectionsReused: stats.connectionsReused,
          deltaRequests: stats.deltaRequests,
          fullContextRequests: stats.fullContextRequests,
          failures: stats.websocketFailures,
          fallbacks: stats.sseFallbacks,
        })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: `${directory}/benchmark.sqlite` })))
  }).pipe(
    Effect.scoped,
    Effect.timeout('10 minutes'),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logError({
          event: 'benchmark-failed',
          stage,
          tag: isTaggedError(error) ? error._tag : 'unknown',
        })
        process.exitCode = 1
      }),
    ),
  ),
)
