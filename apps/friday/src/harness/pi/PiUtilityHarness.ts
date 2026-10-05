import type { Models } from '@earendil-works/pi-ai'
import {
  MemoryStorage,
  type AgentChange,
  type Conversation,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'

import { createToolRegistry, openHarness, piOperation } from '@friday/pi-durable-effect'

/** Short-lived utility calls use the same harness without keeping a user transcript. */
export const withPiUtility = <A>(
  models: Models,
  agent: AgentChange,
  tools: readonly ToolRegistration[],
  use: (
    conversation: Conversation,
  ) => Effect.Effect<A, import('./PiDurableError.ts').PiDurableError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const toolRegistry = createToolRegistry()
      const loadout = yield* toolRegistry.provide('friday-utility', { tools })
      const { registry } = toolRegistry
      const harness = yield* openHarness(new MemoryStorage(), { models, registry })
      const conversation = yield* piOperation('utility-conversation', (context) =>
        harness.root(context, { agent: { ...agent, ...loadout } }),
      )
      return yield* use(conversation)
    }),
  )
