/* oxlint-disable effecttsgo/async-function -- Promise callbacks adapt the Pi utility SDK; application workflows use Effect. */
import type { Models } from '@earendil-works/pi-ai'
import { AssistantEntry, GenerationTask, hook, MemoryStorage } from '@earendil-works/pi-durable'
import { createToolRegistry, openHarness, piOperation } from '@friday/pi-durable-effect'
import * as Effect from 'effect/Effect'
import type { OptChatPrefix } from './OptChatPrefix.ts'
import { bytes, summaryBytes } from './OptChatTree.ts'
import { splitOptChatView, withOptChatCache } from './OptChatCache.ts'
import type { AppConfig } from '../config/AppConfig.ts'
import { PiDurableError } from '../harness/pi/PiDurableError.ts'
import { refreshSharedModelRuntime } from '../harness/pi/PiModelRefresh.ts'

export interface CompressInput {
  readonly context: string
  readonly source: string
  readonly merge: boolean
  readonly prefix?: OptChatPrefix | undefined
}
export type Compress = (input: CompressInput) => Effect.Effect<string, PiDurableError>

/** All correction attempts remain in the same utility conversation. */
export const makeOptChatCompressor = (
  models: Models,
  utility: () => AppConfig['models']['utility'],
  cwd: string,
): Compress =>
  Effect.fn('OptChat.compress')(function* (input) {
    if (bytes(input.source) <= summaryBytes) return input.source
    const prefix = input.prefix
    if (prefix === undefined)
      return yield* new PiDurableError({
        operation: 'optchat-compress',
        detail: 'The channel request prefix has not been recorded yet.',
      })
    yield* refreshSharedModelRuntime(
      models,
      (failure) => new PiDurableError({ operation: 'optchat-compress', ...failure }),
    )
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = createToolRegistry()
        const agent = yield* registry.provide('optchat-compressor', {
          tools: [],
          systemPrompt: () => Effect.succeed(prefix.systemPrompt),
          hooks: [
            hook(GenerationTask, {
              beforeRequest: (request) => ({
                messages: [
                  {
                    role: 'system',
                    content: prefix.systemPrompt,
                    toolsAdded: [...prefix.tools],
                    timestamp: 0,
                  },
                  ...request.messages.filter((message) => message.role !== 'system'),
                ],
              }),
            }),
          ],
        })
        const harness = yield* openHarness(new MemoryStorage(), {
          models: withOptChatCache(models),
          registry: registry.registry,
          settings: { compaction: { enabled: false } },
        })
        const model = utility()
        const conversation = yield* piOperation('optchat-compress', (context) =>
          harness.root(context, {
            agent: { ...agent, model, thinkingLevel: model.thinkingLevel, cwd },
          }),
        )
        const ruler = '-'.repeat(summaryBytes)
        let prompt: import('@earendil-works/pi-ai').UserMessage['content'] = [
          ...splitOptChatView(input.context).map((text) => ({ type: 'text' as const, text })),
          {
            type: 'text',
            text: [
              `Compaction: ${input.merge ? 'merge these adjacent lines' : 'compress this message'} into one line of at most ${summaryBytes} bytes (about 70 words), the length of this ruler:`,
              ruler,
              '<chat> is context for <input>; never add facts absent from <input>.',
              `<input>\n${input.source}\n</input>`,
            ].join('\n'),
          },
        ]
        const attempts: string[] = []
        for (let attempt = 0; attempt < 5; attempt++) {
          const answer = yield* piOperation('optchat-compress', async (context) => {
            const submission = await conversation.submit(
              { type: 'input', content: prompt },
              context,
            )
            const settled = await submission.wait(context)
            if (settled.type !== 'input' || settled.status !== 'done')
              throw new Error('OptChat summarization failed.')
            const entry = await conversation.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer),
              context,
            )
            return (
              entry?.model
                ?.flatMap((message) =>
                  message.role === 'assistant'
                    ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
                    : [],
                )
                .join('')
                .trim() ?? ''
            )
          })
          if (answer.length === 0)
            return yield* new PiDurableError({
              operation: 'optchat-compress',
              detail: 'The compactor returned an empty summary.',
            })
          attempts.push(answer)
          if (bytes(answer) <= summaryBytes) break
          const cut = new TextDecoder()
            .decode(new TextEncoder().encode(answer).slice(0, summaryBytes))
            .replace(/\uFFFD$/, '')
          prompt = `Too long: your line is ${bytes(answer)} bytes, over the ${summaryBytes}-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\n${cut}| ← LIMIT`
        }
        return attempts.reduce((shortest, current) =>
          bytes(current) < bytes(shortest) ? current : shortest,
        )
      }),
    )
  })
