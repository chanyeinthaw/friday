/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/process-env, effecttsgo/strict-effect-provide, eslint/no-underscore-dangle -- This is an explicitly invoked Bun-only live provider smoke test; Effect exits and Options use the canonical _tag discriminator. */

import { expect, test } from 'bun:test'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import { ChannelThread, Turn, TurnId } from '@friday/contracts/conversation'
import {
  createAgentSession,
  ModelRuntime,
  SettingsManager,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makePiThreadRuntime } from './PiThreadRuntime.ts'

const enabled = process.env.FRIDAY_LIVE_PI === '1'
const compactionEnabled = process.env.FRIDAY_LIVE_PI_COMPACTION === '1'
const modelSlug = process.env.FRIDAY_PI_MODEL ?? 'opencode-go/deepseek-v4-flash'
const thinkingLevelInput = process.env.FRIDAY_PI_THINKING_LEVEL ?? 'max'
const separator = modelSlug.indexOf('/')
const provider = modelSlug.slice(0, separator)
const modelId = modelSlug.slice(separator + 1)

const LiveThinkingLevel = Schema.Literals([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])
const decodeThinkingLevel = Schema.decodeUnknownSync(LiveThinkingLevel)
const decodeChannelThread = Schema.decodeSync(ChannelThread)
const decodeTurn = Schema.decodeSync(Turn)
const decodeTurnId = Schema.decodeSync(TurnId)
const thinkingLevel = decodeThinkingLevel(thinkingLevelInput)

const liveTest = enabled ? test : test.skip
const liveCompactionTest = compactionEnabled ? test : test.skip

liveTest(
  `runs a real Pi turn with ${modelSlug} at ${thinkingLevel}`,
  async () => {
    if (separator <= 0 || separator === modelSlug.length - 1) {
      throw new Error(`FRIDAY_PI_MODEL must use provider/model format: ${modelSlug}`)
    }
    const directory = await mkdtemp(join(tmpdir(), 'friday-live-pi-test-'))
    const thread = decodeChannelThread({
      id: 'thread-live-pi',
      audience: 'user',
      parent: null,
      harness: 'pi',
      harnessSession: null,
      workingDirectory: directory,
      model: { provider, modelId },
      thinkingLevel,
      externalBinding: {
        platform: 'discord',
        channelId: 'live-channel',
        sourceMessageId: 'live-message',
        externalThreadId: 'live-thread',
      },
      status: 'active',
      createdAt: '2026-03-21T09:00:00.000Z',
      updatedAt: '2026-03-21T09:00:00.000Z',
      closedAt: null,
    })
    const turn = decodeTurn({
      id: 'turn-live-pi',
      threadId: thread.id,
      sequence: 1,
      input: {
        source: 'user',
        content: {
          text: 'Reply with exactly FRIDAY_PI_OK and no other text. Do not use tools.',
          images: [],
        },
      },
      agentMessage: null,
      activities: [],
      model: thread.model,
      thinkingLevel: thread.thinkingLevel,
      harnessTurnId: null,
      status: 'pending',
      requestedAt: '2026-03-21T10:00:00.000Z',
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      usage: null,
    })
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makePiThreadRuntime({ thread, modelRuntime })
        const terminal = yield* runtime.events.pipe(
          Stream.filter(
            (event) =>
              event.type === 'turn-completed' ||
              event.type === 'turn-interrupted' ||
              event.type === 'turn-failed',
          ),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* runtime.prompt({
          turnId: turn.id,
          message: turn.input,
          mode: 'turn',
        })
        return yield* Fiber.await(terminal)
      }),
    ).pipe(Effect.provide(BunCrypto.layer))

    const exit = await Effect.runPromise(program)
    await rm(directory, { recursive: true, force: true })

    expect(exit._tag).toBe('Success')
    if (exit._tag !== 'Success' || exit.value._tag !== 'Some') return
    expect(exit.value.value.type).toBe('turn-completed')
    if (exit.value.value.type !== 'turn-completed') return
    expect(exit.value.value.agentMessage.trim()).toBe('FRIDAY_PI_OK')
  },
  { timeout: 120_000 },
)

liveCompactionTest(
  `steers a real Pi turn during automatic compaction with ${modelSlug} at ${thinkingLevel}`,
  async () => {
    if (separator <= 0 || separator === modelSlug.length - 1) {
      throw new Error(`FRIDAY_PI_MODEL must use provider/model format: ${modelSlug}`)
    }
    const directory = await mkdtemp(join(tmpdir(), 'friday-live-pi-compaction-test-'))
    const modelsPath = join(directory, 'models.json')
    const contextWindow = Number(process.env.FRIDAY_PI_COMPACTION_CONTEXT_WINDOW ?? 16_000)
    const reserveTokens = Number(process.env.FRIDAY_PI_COMPACTION_RESERVE_TOKENS ?? 6_000)
    const keepRecentTokens = Number(process.env.FRIDAY_PI_COMPACTION_KEEP_RECENT_TOKENS ?? 4_000)
    const payloadRepeats = Number(process.env.FRIDAY_PI_COMPACTION_PAYLOAD_REPEATS ?? 300)
    const maxTurns = Number(process.env.FRIDAY_PI_COMPACTION_MAX_TURNS ?? 4)
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          [provider]: {
            modelOverrides: {
              [modelId]: { contextWindow, maxTokens: Math.min(8_192, reserveTokens) },
            },
          },
        },
      }),
    )
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath,
    })
    const thread = decodeChannelThread({
      id: 'thread-live-pi-compaction',
      audience: 'user',
      parent: null,
      harness: 'pi',
      harnessSession: null,
      workingDirectory: directory,
      model: { provider, modelId },
      thinkingLevel,
      externalBinding: {
        platform: 'discord',
        channelId: 'live-compaction-channel',
        sourceMessageId: 'live-compaction-message',
        externalThreadId: 'live-compaction-thread',
      },
      status: 'active',
      createdAt: '2026-03-21T09:00:00.000Z',
      updatedAt: '2026-03-21T09:00:00.000Z',
      closedAt: null,
    })
    let createdSession: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined
    const program = Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makePiThreadRuntime({
          thread,
          modelRuntime,
          createSession: async (options) => {
            const created = await createAgentSession({
              ...options,
              settingsManager: SettingsManager.inMemory({
                compaction: { enabled: true, reserveTokens, keepRecentTokens },
              }),
            })
            createdSession = created.session
            return created
          },
        })
        const session = createdSession
        if (!session) return yield* Effect.die(new Error('Pi session was not captured'))
        let steeringSent = false
        const effectContext = yield* Effect.context()
        const runPromise = Effect.runPromiseWith(effectContext)
        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          if (event.type !== 'compaction_start' || steeringSent) return Promise.resolve()
          steeringSent = true
          return runPromise(
            runtime.prompt({
              turnId: decodeTurnId('turn-live-pi-compaction-active'),
              message: {
                source: 'user',
                content: {
                  text: 'Reply with exactly FRIDAY_PI_COMPACTION_STEERING_OK and no other text.',
                  images: [],
                },
              },
            }),
          )
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
        const payload = 'Friday compaction history marker ALPHA. '.repeat(payloadRepeats)
        for (let sequence = 0; sequence < maxTurns; sequence++) {
          const turnId = decodeTurnId(`turn-live-pi-compaction-${sequence}`)
          const terminal = yield* runtime.events.pipe(
            Stream.filter(
              (event) =>
                event.turnId === turnId &&
                (event.type === 'turn-completed' ||
                  event.type === 'turn-interrupted' ||
                  event.type === 'turn-failed'),
            ),
            Stream.runHead,
            Effect.forkScoped,
          )
          yield* runtime.prompt({
            turnId,
            message: {
              source: 'user',
              content: {
                text: `History block ${sequence}. ${payload} After any automatic compaction, reply briefly.`,
                images: [],
              },
            },
            mode: 'turn',
          })
          const exit = yield* Fiber.await(terminal)
          if (!steeringSent || exit._tag !== 'Success' || exit.value._tag !== 'Some') continue
          return exit.value.value
        }
        return yield* Effect.die(new Error('Automatic Pi compaction was not observed'))
      }),
    ).pipe(Effect.provide(BunCrypto.layer))

    const terminal = await Effect.runPromise(program)
    await rm(directory, { recursive: true, force: true })

    expect(terminal.type).toBe('turn-completed')
    if (terminal.type !== 'turn-completed') return
    expect(terminal.agentMessage.trim()).toBe('FRIDAY_PI_COMPACTION_STEERING_OK')
  },
  { timeout: 600_000 },
)
