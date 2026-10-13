/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests -- Bun and the faux provider are integration boundaries. */
import { expect, test } from 'bun:test'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript'
import { MemoryStorage, type Harness } from '@earendil-works/pi-durable'
import { createToolRegistry, openHarness, piOperation } from '@friday/pi-durable-effect'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import { Effect } from 'effect'
import { makeOptChatHarness } from './OptChatHarness.ts'
import { makeOptChatMemory } from './OptChatMemory.ts'
import { makeOptChatTools } from './OptChatTools.ts'

test('freezes the memory view without duplicating system sections across tool steps', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const policy = 'Use OptChat to retrieve earlier decisions.'
      const prompts: string[] = []
      const tails: string[][] = []
      const faux = fauxProvider({ tokensPerSecond: Infinity })
      const inspect = (context: Parameters<typeof getCurrentSystemPrompt>[0]) =>
        prompts.push(getCurrentSystemPrompt(context))
      faux.setResponses([
        (context) => {
          inspect(context.messages)
          return fauxAssistantMessage(fauxToolCall('date', { id: 0 }, { id: 'lookup-date' }), {
            stopReason: 'toolUse',
          })
        },
        (context) => {
          inspect(context.messages)
          tails.push(
            context.messages.flatMap((message) =>
              message.role === 'toolResult'
                ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
                : [],
            ),
          )
          return fauxAssistantMessage('The decision was recorded in October.')
        },
      ])
      const models = createModels()
      models.setProvider(faux.provider)
      const memory = yield* makeOptChatMemory((input) => Effect.succeed(input.source))
      yield* memory.append('user-one', [
        {
          sourceKey: 'seed',
          kind: 'user',
          text: 'Keep the chat private.',
          date: '2026-10-13T00:00:00Z',
        },
      ])
      yield* memory.pump('user-one')
      let activeHarness: Harness | undefined
      const optChat = makeOptChatHarness(memory, () => {
        if (!activeHarness) throw new Error('Harness missing.')
        return activeHarness
      })
      const registry = createToolRegistry()
      const loadout = yield* registry.provide('optchat-test', {
        tools: makeOptChatTools(memory, 'user-one'),
        systemPrompt: () => Effect.succeed(policy),
        hooks: optChat.hooks('user-one'),
      })
      const harness = yield* openHarness(new MemoryStorage(), {
        models,
        registry: registry.registry,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      })
      activeHarness = harness
      const model = faux.getModel()
      const conversation = yield* piOperation('create', (context) =>
        harness.createConversation(
          {
            ownership: { kind: 'ownerless' },
            agent: { ...loadout, model: { provider: model.provider, modelId: model.id } },
          },
          context,
        ),
      )
      yield* optChat.activate(conversation, 'user-one')
      yield* piOperation('submit', (context) =>
        conversation.submit(
          { type: 'input', content: 'When was the first decision recorded?' },
          context,
        ),
      )
      yield* piOperation('idle', (context) => conversation.waitForIdle(context))
      expect(prompts).toEqual([policy, policy])
      expect(tails).toEqual([['2026-10-13T00:00:00Z']])
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
      Effect.scoped,
      Effect.timeout('5 seconds'),
    ),
  ))
