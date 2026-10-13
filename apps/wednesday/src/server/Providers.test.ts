import { expect, it } from '@effect/vitest'
import { Effect, Redacted, Schema, Stream } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { configuredModel, defaultMapping } from './Providers.ts'

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ prompt_cache_key: Schema.optionalKey(Schema.String) })),
)

for (const stream of [false, true])
  it.effect(`sends OpenAI cache identity after SDK conversion with streaming=${stream}`, () =>
    Effect.gen(function* () {
      const mapping = defaultMapping('gpt-6.1-sol')
      const model = yield* configuredModel(
        {
          provider: 'api',
          baseUrl: 'https://provider.example/v1',
          modelId: mapping.id,
          models: [mapping],
          thinking: 'low',
        },
        Redacted.make('test-secret'),
        mapping,
        'low',
        'user-cache-identity',
      ).make
      const options = { prompt: 'Reply OK.' }
      if (stream) yield* Stream.runDrain(model.streamText(options))
      else yield* model.generateText(options)
    }).pipe(
      Effect.provideService(
        FetchHttpClient.Fetch,
        Object.assign(
          async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const request = new Request('https://provider.example/v1/chat/completions', init)
            expect(request.headers.get('Session-Id')).toBe('user-cache-identity')
            expect(decodeBody(await request.text()).prompt_cache_key).toBe('user-cache-identity')
            const response = {
              id: 'reply',
              object: stream ? 'chat.completion.chunk' : 'chat.completion',
              created: 1,
              model: 'gpt-6.1-sol',
              choices: [
                {
                  index: 0,
                  ...(stream
                    ? { delta: { content: 'OK' } }
                    : { message: { role: 'assistant', content: 'OK' } }),
                  finish_reason: 'stop',
                },
              ],
            }
            return new Response(
              stream
                ? `data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`
                : JSON.stringify(response),
              { headers: { 'Content-Type': stream ? 'text/event-stream' : 'application/json' } },
            )
          },
          { preconnect: fetch.preconnect },
        ),
      ),
    ),
  )
