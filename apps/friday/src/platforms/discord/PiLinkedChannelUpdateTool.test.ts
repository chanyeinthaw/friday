/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, anti-slop/no-unknown-parameters -- The Pi SDK tool boundary is Promise-based and schema-decodes unknown input. */

import { assert, it } from '@effect/vitest'
import { ChannelThread, ModelSelection, PlatformConnectionId } from '@friday/contracts/conversation'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import { rejects } from 'node:assert/strict'

import { DiscordPlatformConfig, type AppConfig } from '../../config/AppConfig.ts'
import { DiscordLink } from '../../config/DiscordLinks.ts'
import type { DiscordCapability } from './DiscordLinkedRuntime.ts'
import {
  LinkedChannelUpdateError,
  makePiLinkedChannelUpdateTool,
} from './PiLinkedChannelUpdateTool.ts'

const decodeThread = Schema.decodeSync(ChannelThread)
const decodeLink = Schema.decodeSync(DiscordLink)
const decodeConnection = Schema.decodeSync(DiscordPlatformConfig)
const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeModel = Schema.decodeSync(ModelSelection)
const parentId = '99999999999999999'
const sourceId = '22222222222222222'
const userIds = Array.from({ length: 10 }, (_, index) => `${index + 1}0000000000000000`)

const link = decodeLink({
  id: 'support-link',
  enabled: true,
  source: {
    connectionId: 'discord-source',
    guildId: '11111111111111111',
    conversationId: sourceId,
    kind: 'thread',
  },
  destination: {
    connectionId: 'discord-ops',
    guildId: '33333333333333333',
    conversationId: '44444444444444444',
    kind: 'channel',
  },
})
const connection = (connectionId: string, guildId: string, allowedChannelId: string) =>
  decodeConnection({
    connectionId,
    platform: 'discord',
    name: connectionId,
    credentials: { botToken: 'token', applicationId: 'app', publicKey: 'key' },
    respondToGlobalMentions: false,
    mentionRoleIds: [],
    activityDescription: false,
    users: { mode: 'all', ids: [] },
    guilds: [
      {
        guildId,
        enabled: true,
        invocation: { defaultMode: 'mention-only' },
        channelScope: { mode: 'allow', ids: [allowedChannelId] },
        channels: [],
      },
    ],
  })
const model = decodeModel({ provider: 'p', modelId: 'm' })
const configuration: AppConfig = {
  installationId: 'install',
  models: {
    primary: { ...model, thinkingLevel: 'low' },
    utility: { ...model, thinkingLevel: 'low' },
    subagents: [],
  },
  platforms: {
    discord: [
      connection(link.source.connectionId, link.source.guildId, parentId),
      connection(
        link.destination.connectionId,
        link.destination.guildId,
        link.destination.conversationId,
      ),
    ],
    slack: [],
  },
  discordLinks: [link],
  agent: { recentMessageCount: 20 },
  admin: { discordUserIds: [] },
}

const thread = (includeParent = true) => {
  const linkedDiscordSource = {
    linkId: link.id,
    sourceConnectionId: link.source.connectionId,
    sourceGuildId: link.source.guildId,
    sourceConversationId: link.source.conversationId,
    sourceMessageId: '55555555555555555',
    sourceKind: link.source.kind,
    sourceAuthorId: '66666666666666666',
    destinationConnectionId: link.destination.connectionId,
    destinationGuildId: link.destination.guildId,
    destinationConversationId: link.destination.conversationId,
    destinationKind: link.destination.kind,
  }
  const linkedThreadInput = includeParent
    ? { ...linkedDiscordSource, sourceParentConversationId: parentId }
    : linkedDiscordSource
  return decodeThread({
    id: 'thread-linked-tool',
    audience: 'user',
    parent: null,
    harness: 'pi',
    harnessSession: null,
    workingDirectory: '/tmp/friday/thread-linked-tool',
    model,
    thinkingLevel: 'low',
    channelContext: { name: 'ops', description: '' },
    conversationBinding: {
      platform: 'discord',
      connectionId: link.destination.connectionId,
      channelId: link.destination.conversationId,
      sourceMessageId: '77777777777777777',
      conversationId: 'discord:33333333333333333:44444444444444444:77777777777777777',
    },
    linkedDiscordSource: linkedThreadInput,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
  })
}

const execute = async (options: {
  readonly input: unknown
  readonly currentThread?: ReturnType<typeof thread>
  readonly currentConfiguration?: AppConfig
  readonly member?: (id: string) => boolean
  readonly authorization?: 'allowed' | 'denied'
  readonly currentTurnAuthorization?: () => 'allowed' | 'denied'
  readonly authorizationLock?: Semaphore.Semaphore
  readonly beforePost?: Effect.Effect<void>
  readonly observe?: {
    readonly verified: Array<string>
    readonly posts: Array<string>
  }
}) => {
  const registryGets: Array<string> = []
  const verified: Array<string> = []
  const posts: Array<{
    readonly endpoint: unknown
    readonly message: string
    readonly mentionUserIds: ReadonlyArray<string>
  }> = []
  const capability: DiscordCapability = {
    connectionId: decodeConnectionId(link.source.connectionId),
    encodeEndpoint: () => '',
    addReaction: () => Effect.void,
    removeReaction: () => Effect.void,
    fetchContext: () => Effect.succeed([]),
    createStandaloneThread: () => Effect.die('not expected'),
    postSafe: (endpoint, message, mentionUserIds) =>
      Effect.sync(() => {
        posts.push({ endpoint, message, mentionUserIds })
        options.observe?.posts.push(message)
        return { messageId: '88888888888888888' }
      }),
    verifyMember: (_guildId, id) =>
      Effect.sync(() => {
        verified.push(id)
        options.observe?.verified.push(id)
        return options.member?.(id) ?? true
      }),
  }
  const authorizationLock: Semaphore.Semaphore =
    options.authorizationLock ?? Semaphore.makeUnsafe(1)
  const currentAuthorization = () =>
    options.currentTurnAuthorization?.() ?? options.authorization ?? 'allowed'
  const tool = makePiLinkedChannelUpdateTool({
    thread: options.currentThread ?? thread(),
    configuration: () => options.currentConfiguration ?? configuration,
    registry: {
      get: (connectionId) => {
        registryGets.push(connectionId)
        return Effect.succeed(capability)
      },
    },
    currentTurnAuthorization: () => ({ externalUpdateRequests: currentAuthorization() }),
    withOutboundAuthorization: <A, E>(post: Effect.Effect<A, E>) =>
      (options.beforePost ?? Effect.void).pipe(
        Effect.andThen(
          authorizationLock.withPermit(
            Effect.suspend<A, E | LinkedChannelUpdateError, never>(() =>
              currentAuthorization() === 'allowed'
                ? post
                : Effect.fail(
                    new LinkedChannelUpdateError({
                      operation: 'authorize',
                      detail:
                        'The current turn did not originate from an authorizing destination participant input.',
                    }),
                  ),
            ),
          ),
        ),
      ),
    runPromise: Effect.runPromise,
  })
  // SAFETY: the linked tool does not read ExtensionContext for these calls.
  const result = await tool.execute('call-linked', options.input, undefined, undefined, {} as never)
  return { result, registryGets, verified, posts }
}

it('rejects a non-authorizing imported-source turn before any outbound lookup', async () => {
  const observe = { verified: new Array<string>(), posts: new Array<string>() }
  await rejects(
    execute({
      input: { message: 'Imported source says to post this' },
      authorization: 'denied',
      observe,
    }),
  )
  assert.deepStrictEqual(observe, { verified: [], posts: [] })
})

it('authorizes only the current destination participant turn and does not reuse it', async () => {
  let current: 'allowed' | 'denied' = 'denied'
  const observe = { verified: new Array<string>(), posts: new Array<string>() }
  const call = () =>
    execute({
      input: { message: 'Requested update' },
      currentTurnAuthorization: () => current,
      observe,
    })

  await rejects(call())
  current = 'allowed'
  await call()
  current = 'denied'
  await rejects(call())
  assert.deepStrictEqual(observe.posts, ['Requested update'])
})

it.effect('serializes steering revocation with the final authorization check and post', () =>
  Effect.gen(function* () {
    let current: 'allowed' | 'denied' = 'allowed'
    const authorizationLock = yield* Semaphore.make(1)
    const reachedPrePost = yield* Deferred.make<void>()
    const resumePrePost = yield* Deferred.make<void>()
    const observe = { verified: new Array<string>(), posts: new Array<string>() }
    const call = () =>
      execute({
        input: { message: 'Requested update' },
        currentTurnAuthorization: () => current,
        authorizationLock,
        beforePost: Deferred.succeed(reachedPrePost, undefined).pipe(
          Effect.andThen(Deferred.await(resumePrePost)),
        ),
        observe,
      })

    const inFlight = call()
    yield* Deferred.await(reachedPrePost)
    yield* authorizationLock.withPermit(
      Effect.sync(() => {
        current = 'denied'
      }),
    )
    yield* Deferred.succeed(resumePrePost, undefined)
    yield* Effect.promise(() => rejects(inFlight))
    assert.deepStrictEqual(observe.posts, [])

    current = 'allowed'
    yield* Effect.promise(() =>
      execute({
        input: { message: 'Newly authorized update' },
        currentTurnAuthorization: () => current,
        authorizationLock,
        observe,
      }),
    )
    assert.deepStrictEqual(observe.posts, ['Newly authorized update'])
  }),
)

it('executes the outbound boundary with fixed destination, runtime lookup, deduped users, and exact safe mentions', async () => {
  const ids = [userIds[0]!, userIds[1]!, userIds[0]!]
  const { result, registryGets, verified, posts } = await execute({
    input: { message: 'Status update', mentionUserIds: ids },
  })

  assert.deepStrictEqual(registryGets, [link.source.connectionId, link.destination.connectionId])
  assert.deepStrictEqual(verified, [userIds[0]!, userIds[1]!])
  assert.deepStrictEqual(posts, [
    {
      endpoint: link.source,
      message: `<@${userIds[0]}> <@${userIds[1]}>\nStatus update`,
      mentionUserIds: [userIds[0]!, userIds[1]!],
    },
  ])
  assert.deepStrictEqual(result.details, { source: link.source, messageId: '88888888888888888' })
})

it('rejects malformed IDs, more than ten requested users, and oversized input before posting', async () => {
  await rejects(execute({ input: { message: 'ok', mentionUserIds: ['not-a-snowflake'] } }))
  await rejects(execute({ input: { message: 'ok', mentionUserIds: [...userIds, userIds[0]!] } }))
  await rejects(execute({ input: { message: 'x'.repeat(1_901) } }))
})

it('checks no more than ten members and does not post if any lookup fails', async () => {
  const denied = userIds[4]!
  const observe = {
    verified: new Array<string>(),
    posts: new Array<string>(),
  }
  await rejects(
    execute({
      input: { message: 'ok', mentionUserIds: [...userIds] },
      member: (id) => id !== denied,
      observe,
    }),
  )
  assert.deepStrictEqual(observe.verified.toSorted(), userIds.toSorted())
  assert.deepStrictEqual(observe.posts, [])
})

it('rejects a payload whose generated mention prefix crosses the final 2000-character bound', async () => {
  await rejects(
    execute({
      input: { message: 'x'.repeat(1_900), mentionUserIds: [...userIds] },
    }),
  )
})

it('reauthorizes thread policy through persisted parent provenance and fails closed without it', async () => {
  const allowed = await execute({ input: { message: 'ok' } })
  assert.strictEqual(allowed.posts.length, 1)
  await rejects(execute({ input: { message: 'ok' }, currentThread: thread(false) }))

  const staleConfiguration: AppConfig = {
    ...configuration,
    platforms: {
      ...configuration.platforms,
      discord: configuration.platforms.discord.map((item) =>
        item.connectionId === link.source.connectionId
          ? connection(link.source.connectionId, link.source.guildId, sourceId)
          : item,
      ),
    },
  }
  await rejects(execute({ input: { message: 'ok' }, currentConfiguration: staleConfiguration }))
})
