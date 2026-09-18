import type { Thread } from '@friday/contracts/conversation'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type * as Effect from 'effect/Effect'

import { makePiPostPlatformTool } from './PiPostPlatformTool.ts'
import { makePiQueryPlatformTool } from './PiQueryPlatformTool.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'
import type { PlatformPostIdempotency } from './PlatformPostIdempotency.ts'

export interface UserFacingPlatformToolsOptions {
  readonly thread: Thread
  readonly platforms: Pick<
    PlatformRegistryContract,
    'searchMessages' | 'getMessage' | 'postMessage'
  >
  readonly idempotency?: PlatformPostIdempotency | undefined
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
}

/**
 * Model-facing platform tools for user threads. Query and post are
 * registered only for user-facing channel threads: agent threads never
 * receive them, and the post tool stays separate from the normal response
 * publication path. Returns an empty list for any other audience.
 */
export const makeUserFacingPlatformTools = (
  options: UserFacingPlatformToolsOptions,
): ReadonlyArray<ToolDefinition> => {
  if (options.thread.audience !== 'user') return []
  return [
    makePiQueryPlatformTool({
      thread: options.thread,
      platforms: options.platforms,
      runPromise: options.runPromise,
    }),
    makePiPostPlatformTool({
      thread: options.thread,
      platforms: options.platforms,
      idempotency: options.idempotency,
      runPromise: options.runPromise,
    }),
  ]
}
