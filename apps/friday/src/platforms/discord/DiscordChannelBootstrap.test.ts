import { ConversationBinding, ModelSelection, ThinkingLevel } from '@friday/contracts/conversation'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Crypto from 'effect/Crypto'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeDiscordThreadBootstrap } from './DiscordChannelBootstrap.ts'

const decodeBinding = Schema.decodeSync(ConversationBinding)
const decodeModelSelection = Schema.decodeSync(ModelSelection)

const threadModel = (selection: {
  readonly provider: string
  readonly modelId: string
  readonly thinkingLevel: ThinkingLevel
}) => ({
  ...decodeModelSelection({ provider: selection.provider, modelId: selection.modelId }),
  thinkingLevel: selection.thinkingLevel,
})

const inbound = {
  binding: decodeBinding({
    platform: 'discord',
    connectionId: 'discord-personal',
    channelId: 'channel-1',
    sourceMessageId: 'message-1',
    conversationId: 'conversation-1',
  }),
  // SAFETY: the bootstrap only reads inbound.binding; no message fields are used.
  message: {} as never,
}

// SAFETY: the stub covers the only adapter method the bootstrap calls
// (fetchChannelInfo); the wider DiscordAdapter surface is never touched.
const discordStub = {
  fetchChannelInfo: () =>
    Promise.resolve({ name: 'general', metadata: { raw: {} }, id: 'channel-1' }),
} as never

const liveLayers = Layer.mergeAll(
  // SAFETY: the bootstrap only needs randomUUIDv4 from Crypto; the stub's
  // missing members are never read.
  Layer.succeed(Crypto.Crypto, { randomUUIDv4: Effect.succeed('thread-id') } as never),
  // SAFETY: the bootstrap only needs makeDirectory; the stub's missing members
  // are never read.
  Layer.succeed(FileSystem.FileSystem, { makeDirectory: () => Effect.void } as never),
)

it.effect('reads the model provider exactly once per bootstrap', () =>
  Effect.gen(function* () {
    let modelReads = 0
    const model = () => {
      modelReads += 1
      return threadModel({ provider: 'opencode-go', modelId: 'model-a', thinkingLevel: 'high' })
    }
    const bootstrap = yield* makeDiscordThreadBootstrap({
      discord: discordStub,
      model,
      workingDirectoryRoot: tmpdir(),
    })
    const thread = yield* bootstrap(inbound)
    // One snapshot read: model and thinking level always come from the same
    // configuration snapshot even if a reload happens between reads.
    assert.strictEqual(modelReads, 1)
    assert.deepStrictEqual(thread.model, { provider: 'opencode-go', modelId: 'model-a' })
    assert.strictEqual(thread.thinkingLevel, 'high')
  }).pipe(Effect.provide(liveLayers)),
)

it.effect('pairs model and thinking level coherently from one snapshot', () =>
  Effect.gen(function* () {
    let modelReads = 0
    const model = () => {
      modelReads += 1
      // A reload between two reads would hand back a different model here.
      return modelReads === 1
        ? threadModel({ provider: 'p1', modelId: 'model-b', thinkingLevel: 'low' })
        : threadModel({ provider: 'p2', modelId: 'model-c', thinkingLevel: 'max' })
    }
    const bootstrap = yield* makeDiscordThreadBootstrap({
      discord: discordStub,
      model,
      workingDirectoryRoot: join(tmpdir(), 'bootstrap-coherent'),
    })
    const thread = yield* bootstrap(inbound)
    assert.strictEqual(modelReads, 1)
    assert.deepStrictEqual(thread.model, { provider: 'p1', modelId: 'model-b' })
    assert.strictEqual(thread.thinkingLevel, 'low')
  }).pipe(Effect.provide(liveLayers)),
)
