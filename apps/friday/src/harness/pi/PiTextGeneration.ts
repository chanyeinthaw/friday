import { AssistantEntry } from '@earendil-works/pi-durable'
import { withPiUtility } from './PiUtilityHarness.ts'
import { piOperation } from '@friday/pi-durable-effect'
import * as Effect from 'effect/Effect'

import { PiModelRuntime } from './Live.ts'
import { refreshSharedModelRuntime } from './PiModelRefresh.ts'
import { TextGeneration, TextGenerationError } from '../TextGeneration.ts'

const titlePrompt = (message: string): string =>
  [
    'Generate a concise conversation title from the user message below.',
    'Return only the title: no quotes, label, Markdown, or trailing punctuation.',
    'Use 3 to 8 meaningful words and at most 80 characters.',
    '',
    message,
  ].join('\n')

const cleanTitle = (title: string): string =>
  title
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[.!?]+$/g, '')
    .trim()
    .slice(0, 80)

export const makePiTextGeneration = Effect.fn('makePiTextGeneration')(function* () {
  const modelRuntime = yield* PiModelRuntime

  return TextGeneration.of({
    generateThreadTitle: Effect.fn('PiTextGeneration.generateThreadTitle')(function* (input) {
      yield* refreshSharedModelRuntime(
        modelRuntime,
        (failure) => new TextGenerationError({ operation: 'thread-title', ...failure }),
      )
      const model = modelRuntime.getModel(input.model.provider, input.model.modelId)
      const auth = yield* Effect.tryPromise({
        try: () => modelRuntime.getAuth(input.model.provider),
        catch: (cause) =>
          new TextGenerationError({
            operation: 'thread-title',
            detail: 'Failed to resolve model authentication.',
            cause,
          }),
      })
      if (!model || !auth) {
        return yield* new TextGenerationError({
          operation: 'thread-title',
          detail: `Model '${input.model.provider}/${input.model.modelId}' is unavailable.`,
        })
      }
      const response = yield* withPiUtility(
        modelRuntime,
        {
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          cwd: input.workingDirectory,
          tools: [],
        },
        [],
        (conversation) =>
          piOperation('thread-title', async (context) => {
            const submission = await conversation.submit(
              { type: 'input', content: titlePrompt(input.message) },
              context,
            )
            const settled = await submission.wait(context)
            if (settled.type !== 'input' || settled.status !== 'done')
              throw new Error('Title generation failed.')
            const answer = await conversation.commit(
              (tx) => tx.entry(AssistantEntry, settled.answer),
              context,
            )
            return answer?.model
              ?.flatMap((message) =>
                message.role === 'assistant'
                  ? message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
                  : [],
              )
              .join('')
          }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: 'thread-title',
              detail: 'Title generation failed.',
              cause,
            }),
        ),
      )
      const title = cleanTitle(response ?? '')
      return title.length > 0
        ? title
        : yield* new TextGenerationError({
            operation: 'thread-title',
            detail: 'Title generation returned an empty title.',
          })
    }),
  })
})
