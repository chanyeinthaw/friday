import type { Thread } from '@friday/contracts/conversation'
import type { ToolRegistration } from '@earendil-works/pi-durable'

import { makePiDiscoverPlatformsTool } from './PiDiscoverPlatformsTool.ts'
import { makePiPostPlatformTool } from './PiPostPlatformTool.ts'
import { makePiQueryPlatformTool } from './PiQueryPlatformTool.ts'
import type { PlatformRegistryContract } from './PlatformRegistry.ts'
import type { PlatformPostIdempotency } from './PlatformPostIdempotency.ts'

export interface UserFacingPlatformToolsOptions {
  readonly thread: Thread
  readonly platforms: Pick<
    PlatformRegistryContract,
    'searchMessages' | 'getMessage' | 'postMessage' | 'listMembers' | 'discoverPlatforms'
  >
  readonly idempotency?: PlatformPostIdempotency | undefined
}

/**
 * Model-facing platform tools for user threads. Query, post, and discovery are
 * registered only for user-facing channel threads: agent threads never
 * receive them, and the post tool stays separate from the normal response
 * publication path. Returns an empty list for any other audience.
 */
export const makeUserFacingPlatformTools = (
  options: UserFacingPlatformToolsOptions,
): ReadonlyArray<ToolRegistration> => {
  if (options.thread.audience !== 'user') return []
  return [
    makePiQueryPlatformTool({
      thread: options.thread,
      platforms: options.platforms,
    }),
    makePiPostPlatformTool({
      thread: options.thread,
      platforms: options.platforms,
      idempotency: options.idempotency,
    }),
    makePiDiscoverPlatformsTool({
      thread: options.thread,
      platforms: options.platforms,
    }),
  ]
}
