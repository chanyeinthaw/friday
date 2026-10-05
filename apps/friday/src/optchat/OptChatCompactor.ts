/* oxlint-disable effecttsgo/async-function -- Promise callbacks adapt the Pi utility SDK; application workflows use Effect. */
import type { Models } from '@earendil-works/pi-ai'
import { AssistantEntry, MemoryStorage } from '@earendil-works/pi-durable'
import { createToolRegistry, openHarness, piOperation } from '@friday/pi-durable-effect'
import * as Effect from 'effect/Effect'
import { compactPrompt } from './OptChatPrompt.ts'
import { bytes, summaryBytes } from './OptChatTree.ts'
import { splitOptChatView, withOptChatCache } from './OptChatCache.ts'
import type { AppConfig } from '../config/AppConfig.ts'
import { PiDurableError } from '../harness/pi/PiDurableError.ts'
import { refreshSharedModelRuntime } from '../harness/pi/PiModelRefresh.ts'

export interface CompressInput {
  readonly context: string
  readonly source: string
  readonly merge: boolean
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
    yield* refreshSharedModelRuntime(
      models,
      (failure) => new PiDurableError({ operation: 'optchat-compress', ...failure }),
    )
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = createToolRegistry()
        const agent = yield* registry.provide('optchat-compressor', {
          tools: [],
          systemPrompt: () => Effect.succeed(compactPrompt),
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
        const scalePrefix =
          'user: Keep one endless chat per configured channel and owner. Friday replies in-channel, preserves every message, starts each turn with a summary tree view, and zooms to exact history before acting. work: Pi-durable owns scheduling, tools and restart recovery. echo: SQLite integrity checks passed. tool: Updated configuration without deleting history. talk: Existing channels retain normal routing; tasks report to the originating memory. user: Preserve paths, decisions, reasons and unresolved work.'
        const scale = scalePrefix + ' '.repeat(Math.max(0, summaryBytes - bytes(scalePrefix)))
        let prompt: import('@earendil-works/pi-ai').UserMessage['content'] = [
          ...splitOptChatView(input.context).map((text) => ({ type: 'text' as const, text })),
          {
            type: 'text',
            text: [
              `For scale, this line is exactly ${summaryBytes} bytes:\n${scale}`,
              `${input.merge ? 'Merge these two lines' : 'Compress this message'} into one line, in at most ${summaryBytes} bytes:\n${input.source}`,
            ].join('\n\n'),
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
          prompt = `That line is ${bytes(answer)} bytes; the limit is ${summaryBytes}. It must end where it is cut here:\n${cut}| ← LIMIT`
        }
        return attempts.reduce((shortest, current) =>
          bytes(current) < bytes(shortest) ? current : shortest,
        )
      }),
    )
  })
