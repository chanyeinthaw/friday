import { Effect, Option, Schema, Stream } from 'effect'
import { Sse } from 'effect/encoding'

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
)
const terminal = new Set([
  'response.completed',
  'response.done',
  'response.incomplete',
  'response.failed',
  'error',
])
const isString = Schema.is(Schema.String)
const isUsageEvent = (data: string) => {
  const parsed = decode(data)
  if (Option.isNone(parsed)) return false
  const event = parsed.value
  return (
    (isString(event.type) && terminal.has(event.type)) || event.usage != null || event.error != null
  )
}

/** Stop at terminal usage before the SDK closes its request scope and aborts the clone. */
export const readBenchmarkUsage = Effect.fn('Benchmark.readUsage')(function* (response: Response) {
  const body = response.body
  if (!body) return ''
  const usageEvent = yield* Stream.fromReadableStream({
    evaluate: () => body,
    onError: () => new Error('Provider stream ended before terminal usage.'),
    // Cancelling a tee waits for the SDK's branch, which may stop at completion.
    releaseLockOnEnd: true,
  }).pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.filter((event) => isUsageEvent(event.data)),
    Stream.runHead,
  )
  // Cancel our tee branch without waiting for the SDK's branch to finish.
  // Leaving it open can also block the SDK's own cancellation.
  yield* Effect.tryPromise(() => body.cancel()).pipe(Effect.ignore, Effect.forkDetach)
  return Option.isSome(usageEvent) ? `data: ${usageEvent.value.data}\n` : ''
})
