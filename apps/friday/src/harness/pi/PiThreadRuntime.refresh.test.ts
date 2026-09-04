/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- Focused regression test drives the real Pi ModelRuntime file boundary with temp models.json files; the test entry point provides Bun Crypto. */
import { assert, it } from '@effect/vitest'
import * as BunCrypto from '@effect/platform-bun/BunCrypto'
import { ChannelThread } from '@friday/contracts/conversation'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makePiThreadRuntime, type PiAgentSessionContract } from './PiThreadRuntime.ts'

const decodeThread = Schema.decodeSync(ChannelThread)

const provider = 'friday-stale-test'
const modelId = 'stale-model'

const modelsJson = (name: string, contextWindow: number) =>
  JSON.stringify({
    providers: {
      [provider]: {
        baseUrl: 'http://localhost:1/v1',
        api: 'openai-completions',
        apiKey: 'test-key',
        models: [{ id: modelId, name, contextWindow, maxTokens: 100 }],
      },
    },
  })

it.effect('sees updated model metadata when a new session opens after model file changes', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), 'friday-pi-stale-runtime-')),
      )
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const modelsPath = join(directory, 'models.json')
      const modelsStorePath = join(directory, 'models-store.json')
      const authPath = join(directory, 'auth.json')

      yield* Effect.promise(() => writeFile(modelsPath, modelsJson('stale-v1', 1000)))
      const modelRuntime = yield* Effect.promise(() =>
        ModelRuntime.create({
          allowModelNetwork: false,
          modelsPath,
          modelsStorePath,
          authPath,
        }),
      )
      assert.strictEqual(modelRuntime.getModel(provider, modelId)?.name, 'stale-v1')

      yield* Effect.promise(() => writeFile(modelsPath, modelsJson('stale-v2-updated', 2000)))
      // The shared runtime is stale until the next session refreshes it.
      assert.strictEqual(modelRuntime.getModel(provider, modelId)?.name, 'stale-v1')

      const refreshArgs: Array<unknown> = []
      const originalRefresh = modelRuntime.refresh.bind(modelRuntime)
      modelRuntime.refresh = (options) => {
        refreshArgs.push(options)
        return originalRefresh(options)
      }

      let capturedName: string | undefined
      let capturedContextWindow: number | undefined
      const session = {
        sessionId: 'pi-session-stale-refresh',
        sessionManager: { getSessionFile: () => undefined },
        subscribe: () => () => undefined,
        bindExtensions: () => Promise.resolve(undefined),
        prompt: () => Promise.resolve(undefined),
        abort: () => Promise.resolve(undefined),
        reload: () => Promise.resolve(undefined),
        dispose: () => undefined,
        getSessionStats: () => ({
          sessionFile: undefined,
          sessionId: 'pi-session-stale-refresh',
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        }),
      } satisfies PiAgentSessionContract

      yield* makePiThreadRuntime({
        thread: decodeThread({
          id: 'thread-stale-refresh',
          audience: 'user',
          parent: null,
          harness: 'pi',
          harnessSession: null,
          workingDirectory: directory,
          model: { provider, modelId },
          thinkingLevel: 'max',
          channelContext: { name: 'Friday test channel', description: '' },
          conversationBinding: {
            platform: 'discord',
            connectionId: 'discord',
            channelId: 'channel-stale-refresh',
            sourceMessageId: 'message-stale-refresh',
            conversationId: 'platform-conversation-stale-refresh',
          },
          status: 'active',
          createdAt: '2026-03-21T09:00:00.000Z',
          updatedAt: '2026-03-21T09:00:00.000Z',
          closedAt: null,
        }),
        modelRuntime,
        createSession: (options) => {
          capturedName = options.model?.name
          capturedContextWindow = options.model?.contextWindow
          return Promise.resolve({ session })
        },
      })

      assert.strictEqual(capturedName, 'stale-v2-updated')
      assert.strictEqual(capturedContextWindow, 2000)
      assert.deepStrictEqual(refreshArgs, [{ allowNetwork: false }])
    }),
  ).pipe(Effect.provide(BunCrypto.layer)),
)
