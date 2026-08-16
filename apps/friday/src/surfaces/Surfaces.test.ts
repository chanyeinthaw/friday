import { assert, it } from '@effect/vitest'
import { ExternalBinding } from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { SurfaceContract } from './Surface.ts'
import { Surfaces, SurfacesLive } from './Surfaces.ts'

const discordBinding = Schema.decodeSync(ExternalBinding)({
  platform: 'discord',
  channelId: 'channel-1',
  sourceMessageId: 'message-1',
  externalThreadId: 'thread-1',
})
const slackBinding = Schema.decodeSync(ExternalBinding)({
  platform: 'slack',
  channelId: 'channel-2',
  sourceMessageId: 'message-2',
  externalThreadId: 'thread-2',
})

it.effect('routes simultaneous surface registrations by binding platform', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const surfaces = yield* Surfaces.pipe(Effect.provide(SurfacesLive))
      yield* surfaces.register(makeSurface('discord', events))
      yield* surfaces.register(makeSurface('slack', events))

      yield* surfaces.publish({ binding: discordBinding, text: 'Discord response' })
      yield* surfaces.publish({ binding: slackBinding, text: 'Slack response' })
      yield* surfaces.withTyping(discordBinding, Effect.void)
      yield* surfaces.withTyping(slackBinding, Effect.void)

      assert.deepStrictEqual(events, [
        'discord:Discord response',
        'slack:Slack response',
        'discord:typing',
        'slack:typing',
      ])
    }),
  ),
)

it.effect('replaces a registration for the same surface kind', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events: Array<string> = []
      const surfaces = yield* Surfaces.pipe(Effect.provide(SurfacesLive))
      yield* surfaces.register(makeSurface('discord', events, 'first'))
      yield* surfaces.register(makeSurface('discord', events, 'second'))

      yield* surfaces.publish({ binding: discordBinding, text: 'response' })

      assert.deepStrictEqual(events, ['second:discord:response'])
    }),
  ),
)

const makeSurface = (
  kind: 'discord' | 'slack',
  events: Array<string>,
  label: string = kind,
): SurfaceContract<never> => ({
  kind,
  publish: ({ text }) =>
    Effect.sync(() => events.push(label === kind ? `${kind}:${text}` : `${label}:${kind}:${text}`)),
  withTyping: (_binding, effect) =>
    Effect.sync(() => events.push(`${kind}:typing`)).pipe(Effect.andThen(effect)),
})
