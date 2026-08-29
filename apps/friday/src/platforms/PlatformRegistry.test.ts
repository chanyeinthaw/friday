import { assert, it } from '@effect/vitest'
import { ConversationBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { PlatformAdapter } from './PlatformAdapter.ts'
import { PlatformRegistry, PlatformRegistryLive } from './PlatformRegistry.ts'

const discordBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  channelId: 'channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'thread-1',
})
const slackBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'slack',
  channelId: 'channel-2',
  sourceMessageId: 'message-2',
  conversationId: 'thread-2',
})

it.effect('routes simultaneous platform registrations by binding platform', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register(makePlatform('discord', events))
      yield* platforms.register(makePlatform('slack', events))

      yield* platforms.publish({ binding: discordBinding, text: 'Discord response' })
      yield* platforms.publish({ binding: slackBinding, text: 'Slack response' })
      yield* platforms.withTyping(discordBinding, Effect.void)
      yield* platforms.withTyping(slackBinding, Effect.void)

      assert.deepStrictEqual(events, [
        'discord:Discord response',
        'slack:Slack response',
        'discord:typing',
        'slack:typing',
      ])
    }),
  ),
)

it.effect('replaces a registration for the same platform kind', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register(makePlatform('discord', events, 'first'))
      yield* platforms.register(makePlatform('discord', events, 'second'))

      yield* platforms.publish({ binding: discordBinding, text: 'response' })

      assert.deepStrictEqual(events, ['second:discord:response'])
    }),
  ),
)

const makePlatform = (
  kind: 'discord' | 'slack',
  events: Array<string>,
  label: string = kind,
): PlatformAdapter<never> => ({
  kind,
  publish: ({ text }) =>
    Effect.sync(() => events.push(label === kind ? `${kind}:${text}` : `${label}:${kind}:${text}`)),
  acknowledge: () => Effect.void,
  beginWorking: () => Effect.void,
  updateWorking: () => Effect.void,
  setAgentActivity: () => Effect.void,
  setConversationTitle: () => Effect.void,
  finalizeWorking: () => Effect.void,
  withTyping: (_binding, effect) =>
    Effect.sync(() => events.push(`${kind}:typing`)).pipe(Effect.andThen(effect)),
})
