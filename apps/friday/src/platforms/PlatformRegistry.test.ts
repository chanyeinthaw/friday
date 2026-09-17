import { assert, it } from '@effect/vitest'
import {
  ConversationBinding,
  PlatformConnectionId,
  PlatformMessageId,
  TaskId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { PlatformMessageGetQuery, PlatformRegistration } from './PlatformAdapter.ts'
import { PlatformMessageNotFoundError } from './PlatformAdapter.ts'
import {
  PlatformCapabilityUnavailableError,
  PlatformRegistry,
  PlatformRegistryLive,
} from './PlatformRegistry.ts'

const discordBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'discord',
  connectionId: 'discord',
  channelId: 'channel-1',
  sourceMessageId: 'message-1',
  conversationId: 'thread-1',
})
const decodePlatformConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeTaskId = Schema.decodeSync(TaskId)
const decodeMessageId = Schema.decodeSync(PlatformMessageId)
const isCapabilityUnavailable = Schema.is(PlatformCapabilityUnavailableError)
const isMessageNotFound = Schema.is(PlatformMessageNotFoundError)

const slackBinding = Schema.decodeSync(ConversationBinding)({
  platform: 'slack',
  connectionId: 'slack',
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

it.effect('reports an unavailable optional capability instead of succeeding silently', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register(makePlatform('slack', []))

      const error = yield* platforms
        .setAgentActivity({ binding: slackBinding, taskId: decodeTaskId('task-1'), active: true })
        .pipe(Effect.flip)

      assert(isCapabilityUnavailable(error))
      assert.strictEqual(error.capability, 'agent-activity')
      assert.strictEqual(error.kind, 'slack')
    }),
  ),
)

it.effect('reports message retrieval as unavailable for platforms without the capability', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register(makePlatform('discord', []))

      const error = yield* platforms.getMessage(getQuery('message-9')).pipe(Effect.flip)

      assert(isCapabilityUnavailable(error))
      assert.strictEqual(error.capability, 'message-get')
      assert.strictEqual(error.kind, 'discord')
    }),
  ),
)

it.effect('preserves the generic not-found across the message retrieval boundary', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register({
        ...makePlatform('discord', []),
        messageGet: {
          get: () =>
            Effect.fail(
              new PlatformMessageNotFoundError({ kind: 'discord', messageId: 'message-9' }),
            ),
        },
      })

      const error = yield* platforms.getMessage(getQuery('message-9')).pipe(Effect.flip)

      assert(isMessageNotFound(error))
      assert.strictEqual(error.messageId, 'message-9')
    }),
  ),
)

const makePlatform = (
  kind: 'discord' | 'slack',
  events: Array<string>,
  label: string = kind,
): PlatformRegistration<never> => ({
  connectionId: decodePlatformConnectionId(kind),
  kind,
  publish: ({ text }) =>
    Effect.sync(() => events.push(label === kind ? `${kind}:${text}` : `${label}:${kind}:${text}`)),
  acknowledge: () => Effect.void,
  withTyping: (_binding, effect) =>
    Effect.sync(() => events.push(`${kind}:typing`)).pipe(Effect.andThen(effect)),
})

const getQuery = (messageId: string): PlatformMessageGetQuery => ({
  binding: discordBinding,
  scope: 'thread',
  messageId: decodeMessageId(messageId),
})
