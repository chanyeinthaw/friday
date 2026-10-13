import { expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { readBenchmarkUsage } from './benchmark-stream.ts'

const completed =
  'data: {"type":"response.completed","response":{"model":"test","usage":{"input_tokens":2048,"input_tokens_details":{"cached_tokens":1024}}}}\n\n'

it.effect('captures terminal usage without waiting for the response body to close', () =>
  Effect.gen(function* () {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(
            'data: {"type":"response.created","response":{"model":null,"usage":null}}\n\n' +
              completed,
          )
          for (let offset = 0; offset < bytes.length; offset += 7)
            controller.enqueue(bytes.slice(offset, offset + 7))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    expect(yield* readBenchmarkUsage(response)).toBe(completed.trim() + '\n')
    expect(response.body?.locked).toBe(false)
    yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
    expect(cancelled).toBe(true)
  }),
)
it.effect('recognizes Chat Completions usage and provider errors', () =>
  Effect.gen(function* () {
    for (const data of [
      '{"choices":[],"usage":{"prompt_tokens":2048,"prompt_tokens_details":{"cached_tokens":1024}}}',
      '{"type":"error","error":{"code":"service_unavailable"}}',
    ]) {
      expect(yield* readBenchmarkUsage(new Response(`data: ${data}\n\n`))).toBe(`data: ${data}\n`)
    }
  }),
)
it.effect(
  'captures usage without waiting for the SDK to finish its side of a cloned response',
  () =>
    Effect.gen(function* () {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(completed))
          },
        }),
      )
      const copy = response.clone()
      const observed = yield* readBenchmarkUsage(copy).pipe(Effect.forkScoped)
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Missing response body')
      yield* Effect.promise(() => reader.read())
      const usage = yield* Fiber.join(observed)
      expect(usage).toBe(completed.trim() + '\n')
      // The observer must release its branch so the SDK can cancel independently.
      yield* Effect.promise(() => reader.cancel())
    }),
)
it.effect('does not fabricate usage when the stream ends without a terminal event', () =>
  Effect.gen(function* () {
    expect(yield* readBenchmarkUsage(new Response('data: {"type":"response.created"}\n\n'))).toBe(
      '',
    )
  }),
)
