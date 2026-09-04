import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import * as Effect from 'effect/Effect'

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

// The shared runtime is created once at startup; Pi-owned model/auth files can
// change afterwards. Refresh locally (no network) immediately before model/auth
// resolution so a new session never resolves against stale state.
export const refreshSharedModelRuntime = Effect.fn('refreshSharedModelRuntime')(function* <E>(
  modelRuntime: Pick<ModelRuntime, 'refresh'>,
  makeError: (input: { readonly detail: string; readonly cause?: unknown }) => E,
) {
  const result = yield* Effect.tryPromise({
    try: () => modelRuntime.refresh({ allowNetwork: false }),
    catch: (cause) =>
      makeError({
        detail: `Failed to refresh Pi model state: ${errorDetail(cause)}`,
        cause,
      }),
  })
  if (result.aborted) {
    return yield* Effect.fail(
      makeError({
        detail: 'Pi model refresh was aborted before resolving the model.',
      }),
    )
  }
  if (result.errors.size > 0) {
    const detail = [...result.errors.entries()]
      .map(([provider, cause]) => `${provider}: ${cause.message}`)
      .join('; ')
    return yield* Effect.fail(
      makeError({
        detail,
        cause: new AggregateError([...result.errors.values()], detail),
      }),
    )
  }
  return undefined
})
