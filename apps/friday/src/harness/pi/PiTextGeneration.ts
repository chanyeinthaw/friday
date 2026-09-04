import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent'
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
      const session = yield* Effect.tryPromise({
        try: () =>
          createAgentSession({
            cwd: input.workingDirectory,
            modelRuntime,
            model,
            thinkingLevel: input.thinkingLevel,
            sessionManager: SessionManager.inMemory(input.workingDirectory),
            noTools: 'all',
          }),
        catch: (cause) =>
          new TextGenerationError({
            operation: 'thread-title',
            detail: 'Failed to create the title-generation session.',
            cause,
          }),
      })
      const response = yield* Effect.tryPromise({
        try: async () => {
          try {
            await session.session.prompt(titlePrompt(input.message))
            return session.session.messages
              .toReversed()
              .find((message) => message.role === 'assistant')
              ?.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
              .join('')
          } finally {
            session.session.dispose()
          }
        },
        catch: (cause) =>
          new TextGenerationError({
            operation: 'thread-title',
            detail: 'Title generation failed.',
            cause,
          }),
      })
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
