import { Effect, Stream } from 'effect'
import { LanguageModel, Response, Tool, Toolkit } from 'effect/ai'

// Preserve the model's toolkit-dependent return type when observing text parts.
export function observeText(
  model: LanguageModel.LanguageModel,
  observe: (part: Response.TextDeltaPart) => Effect.Effect<void>,
): LanguageModel.LanguageModel {
  function streamText<Options extends LanguageModel.GenerateTextOptions<Record<string, Tool.Any>>>(
    options: Options,
  ): Stream.Stream<
    Response.StreamPart<
      LanguageModel.ExtractTools<Options>,
      LanguageModel.ExtractToolParametersMode<Options>
    >,
    LanguageModel.ExtractError<Options>,
    LanguageModel.ExtractServices<Options>
  >
  function streamText(options: LanguageModel.GenerateTextOptions<Record<string, Tool.Any>>) {
    const request: LanguageModel.GenerateTextOptions<Record<string, Tool.Any>> & {
      toolkit: LanguageModel.ToolkitInput<Record<string, Tool.Any>>
    } = { ...options, toolkit: options.toolkit ?? Toolkit.empty }
    return model
      .streamText(request)
      .pipe(Stream.tap((part) => (part.type === 'text-delta' ? observe(part) : Effect.void)))
  }
  return { ...model, streamText }
}
