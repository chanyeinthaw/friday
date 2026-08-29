import type { ModelSelection, ThinkingLevel } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export class TextGenerationError extends Schema.Error<TextGenerationError>('TextGenerationError')({
  _tag: Schema.tag('TextGenerationError'),
  operation: Schema.Literal('thread-title'),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface GenerateThreadTitleInput {
  readonly message: string
  readonly workingDirectory: string
  readonly model: ModelSelection
  readonly thinkingLevel: ThinkingLevel
}

export interface TextGenerationContract {
  readonly generateThreadTitle: (
    input: GenerateThreadTitleInput,
  ) => Effect.Effect<string, TextGenerationError>
}

export class TextGeneration extends Context.Service<TextGeneration, TextGenerationContract>()(
  'friday/harness/TextGeneration',
) {}
