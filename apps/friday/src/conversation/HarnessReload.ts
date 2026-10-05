import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'

import type { PlatformThreadLookup, ThreadPersistenceContract } from './ThreadPersistence.ts'
import {
  harnessReloadFailed,
  harnessReloadRefused,
  type HarnessReloadOutcome,
} from './ConversationEvents.ts'
import type { PiDurableContract } from '../harness/pi/PiDurable.ts'

/**
 * Operations the shared harness-reload orchestration needs: resolving the
 * Friday Thread bound to a platform conversation, and reloading its indexed
 * Pi-durable conversation.
 */
export interface HarnessReloadOperations {
  readonly findThread: ThreadPersistenceContract['findPlatformThread']
  readonly reloadRuntime: PiDurableContract['reloadHarness']
}

/**
 * Shared harness-reload operation for one platform conversation: resolves the
 * Friday Thread bound to the conversation and reloads its existing harness
 * conversation in place. Refusals (unknown thread, no indexed conversation, active turn)
 * and failures are structured outcomes; failures never throw across the
 * transport boundary.
 */
export const reloadConversationHarness =
  (operations: HarnessReloadOperations) =>
  (lookup: PlatformThreadLookup): Effect.Effect<HarnessReloadOutcome> =>
    Effect.gen(function* () {
      const found = yield* operations.findThread(lookup)
      if (Option.isNone(found)) {
        return harnessReloadRefused(
          'unknown-thread',
          'No Friday thread is bound to this conversation; run the command inside a Friday thread.',
        )
      }
      return yield* operations.reloadRuntime(found.value.id)
    }).pipe(Effect.catch((cause) => Effect.succeed(harnessReloadFailed(cause.message))))
