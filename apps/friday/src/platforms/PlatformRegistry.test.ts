import { assert, it } from '@effect/vitest'
import {
  ConversationBinding,
  PlatformConnectionId,
  PlatformMessageId,
  TaskId,
} from '@friday/contracts/conversation'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  PlatformDiscoveryQuery,
  PlatformMembersQuery,
  PlatformMessageGetQuery,
  PlatformMessagePostQuery,
  PlatformRegistration,
} from './PlatformAdapter.ts'
import {
  PlatformMembersUnsupportedError,
  PlatformMessageNotFoundError,
  PlatformTargetNotFoundError,
} from './PlatformAdapter.ts'
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

it.effect('reports message posting as unavailable for platforms without the capability', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register(makePlatform('discord', []))

      const error = yield* platforms.postMessage(postQuery('hello')).pipe(Effect.flip)

      assert(isCapabilityUnavailable(error))
      assert.strictEqual(error.capability, 'message-post')
      assert.strictEqual(error.kind, 'discord')
    }),
  ),
)

it.effect('routes message posts through the bound connection', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register({
        ...makePlatform('discord', []),
        messagePost: {
          post: () => Effect.succeed({ messageId: decodeMessageId('posted-1') }),
        },
      })

      const result = yield* platforms.postMessage(postQuery('hello'))

      assert.strictEqual(result.messageId, 'posted-1')
    }),
  ),
)

it.effect('preserves target admission failures across the search and post boundary', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register({
        ...makePlatform('discord', []),
        messageSearch: {
          search: () => Effect.fail(new PlatformTargetNotFoundError({ kind: 'discord' })),
        },
        messagePost: {
          post: () => Effect.fail(new PlatformTargetNotFoundError({ kind: 'discord' })),
        },
      })
      const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)

      const searchError = yield* platforms
        .searchMessages({
          binding: discordBinding,
          target: { platform: 'discord', guildId: 'guild-1', channelId: 'channel-1' },
          limit: 20,
        })
        .pipe(Effect.flip)
      assert(isTargetNotFound(searchError))
      assert.strictEqual(searchError.message, 'Target not found or not accessible.')

      const postError = yield* platforms.postMessage(postQuery('hello')).pipe(Effect.flip)
      assert(isTargetNotFound(postError))
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
  messageId: decodeMessageId(messageId),
})

const postQuery = (text: string): PlatformMessagePostQuery => ({
  binding: discordBinding,
  target: { platform: 'discord', guildId: 'guild-1', channelId: 'channel-1' },
  text,
})

const membersQuery = (): PlatformMembersQuery => ({
  binding: discordBinding,
  target: { platform: 'discord', guildId: 'guild-1', channelId: 'channel-1', threadId: 'thread-1' },
  limit: 20,
})

const discoveryQuery = (): PlatformDiscoveryQuery => ({
  binding: discordBinding,
  action: 'scopes',
  limit: 20,
})

it.effect('reports member listing and discovery as unavailable without the capability', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register(makePlatform('discord', []))

      const membersError = yield* platforms.listMembers(membersQuery()).pipe(Effect.flip)
      assert(isCapabilityUnavailable(membersError))
      assert.strictEqual(membersError.capability, 'message-members')

      const discoveryError = yield* platforms.discoverPlatforms(discoveryQuery()).pipe(Effect.flip)
      assert(isCapabilityUnavailable(discoveryError))
      assert.strictEqual(discoveryError.capability, 'platform-discovery')
    }),
  ),
)

it.effect('preserves scoped not-found and unsupported failures across the boundary', () =>
  Effect.scoped(
    Effect.gen(function* () {
      const platforms = yield* PlatformRegistry.pipe(Effect.provide(PlatformRegistryLive))
      yield* platforms.register({
        ...makePlatform('discord', []),
        members: {
          list: () => Effect.fail(new PlatformTargetNotFoundError({ kind: 'discord' })),
        },
        discovery: {
          discover: () =>
            Effect.fail(
              new PlatformMembersUnsupportedError({
                kind: 'discord',
                detail: 'thread targets only',
              }),
            ),
        },
      })
      const isTargetNotFound = Schema.is(PlatformTargetNotFoundError)
      const isMembersUnsupported = Schema.is(PlatformMembersUnsupportedError)

      const membersError = yield* platforms.listMembers(membersQuery()).pipe(Effect.flip)
      assert(isTargetNotFound(membersError))

      const discoveryError = yield* platforms.discoverPlatforms(discoveryQuery()).pipe(Effect.flip)
      assert(isMembersUnsupported(discoveryError))
      assert.strictEqual(discoveryError.detail, 'thread targets only')
    }),
  ),
)
