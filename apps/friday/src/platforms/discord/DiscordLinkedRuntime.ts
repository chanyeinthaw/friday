/* oxlint-disable anti-slop/no-unknown-parameters -- Discord adapter payloads cross an external boundary and are schema-decoded before use. */

import type { DiscordThreadId } from '@chat-adapter/discord'
import { IsoDateTime, PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type {
  DiscordLinkDestinationEndpoint,
  DiscordLinkSourceEndpoint,
} from '../../config/DiscordLinks.ts'
import type { DiscordRequestBody, FridayDiscordAdapter } from './FridayDiscordAdapter.ts'

const DiscordApiMessage = Schema.Struct({ id: Schema.String })
const decodeDiscordApiMessage = Schema.decodeUnknownEffect(DiscordApiMessage)
const decodeIsoDateTime = Schema.decodeUnknownOption(IsoDateTime)
const safeIsoDateTime = (value: Date | undefined): string | null =>
  value === undefined ? null : Option.getOrNull(decodeIsoDateTime(value.toISOString()))
const DiscordApiChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
})
const decodeDiscordApiChannel = Schema.decodeUnknownEffect(DiscordApiChannel)

export class DiscordCapabilityError extends Schema.Error<DiscordCapabilityError>(
  'DiscordCapabilityError',
)({
  _tag: Schema.tag('DiscordCapabilityError'),
  operation: Schema.Literals(['unavailable', 'discord-api', 'decode']),
  connectionId: Schema.String,
  status: Schema.optional(Schema.Number),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface DiscordSourceMessage {
  readonly id: string
  readonly text: string
  readonly author: { readonly userId: string; readonly userName: string; readonly fullName: string }
  readonly sentAt: string | null
  readonly replyTo?: DiscordSourceMessage | undefined
  readonly attachments: ReadonlyArray<{
    readonly name: string
    readonly url: string
    readonly contentType?: string | undefined
    readonly size?: number | undefined
  }>
}

export interface DiscordCapability {
  readonly connectionId: typeof PlatformConnectionId.Type
  readonly encodeEndpoint: (endpoint: DiscordLinkSourceEndpoint) => string
  readonly addReaction: (
    endpoint: DiscordLinkSourceEndpoint,
    messageId: string,
    emoji: string,
  ) => Effect.Effect<void, DiscordCapabilityError>
  readonly removeReaction: (
    endpoint: DiscordLinkSourceEndpoint,
    messageId: string,
    emoji: string,
  ) => Effect.Effect<void, DiscordCapabilityError>
  readonly fetchContext: (
    endpoint: DiscordLinkSourceEndpoint,
    messageId: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<DiscordSourceMessage>, DiscordCapabilityError>
  readonly createStandaloneThread: (
    endpoint: DiscordLinkDestinationEndpoint,
    title: string,
  ) => Effect.Effect<
    { readonly id: string; readonly conversationId: string },
    DiscordCapabilityError
  >
  readonly postSafe: (
    endpoint: DiscordLinkSourceEndpoint,
    message: string,
    mentionUserIds: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly messageId: string }, DiscordCapabilityError>
  readonly verifyMember: (
    guildId: string,
    userId: string,
  ) => Effect.Effect<boolean, DiscordCapabilityError>
}

export interface DiscordCapabilityRegistryContract {
  readonly register: (capability: DiscordCapability) => Effect.Effect<void>
  readonly get: (
    connectionId: typeof PlatformConnectionId.Type,
  ) => Effect.Effect<DiscordCapability, DiscordCapabilityError>
}

export class DiscordCapabilityRegistry extends Context.Service<
  DiscordCapabilityRegistry,
  DiscordCapabilityRegistryContract
>()('friday/platforms/discord/DiscordCapabilityRegistry') {}

export const DiscordCapabilityRegistryLive = Layer.sync(DiscordCapabilityRegistry, () => {
  const capabilities = new Map<string, DiscordCapability>()
  return DiscordCapabilityRegistry.of({
    register: (capability) =>
      Effect.sync(() => {
        capabilities.set(capability.connectionId, capability)
      }),
    get: (connectionId) => {
      const found = capabilities.get(connectionId)
      return found === undefined
        ? Effect.fail(
            new DiscordCapabilityError({
              operation: 'unavailable',
              connectionId,
              detail: 'Discord connection is not running.',
            }),
          )
        : Effect.succeed(found)
    },
  })
})

interface AdapterAccess extends Pick<
  FridayDiscordAdapter,
  'encodeThreadId' | 'fetchMessages' | 'addReaction' | 'removeReaction' | 'fridayFetchMessage'
> {
  readonly api: (path: string, method: string, body?: DiscordRequestBody) => Promise<Response>
}

const apiEffect = (
  connectionId: string,
  access: AdapterAccess,
  path: string,
  method: string,
  body?: DiscordRequestBody,
) =>
  Effect.tryPromise({
    try: () => access.api(path, method, body),
    catch: (cause) =>
      new DiscordCapabilityError({
        operation: 'discord-api',
        connectionId,
        detail: 'Discord request failed.',
        cause,
      }),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.succeed(response)
        : Effect.fail(
            new DiscordCapabilityError({
              operation: 'discord-api',
              connectionId,
              status: response.status,
              detail: `Discord returned HTTP ${response.status}.`,
            }),
          ),
    ),
  )

const targetChannelId = (
  endpoint: DiscordLinkSourceEndpoint | DiscordLinkDestinationEndpoint,
): string => endpoint.conversationId

export const makeDiscordCapability = (
  connectionId: typeof PlatformConnectionId.Type,
  discord: FridayDiscordAdapter,
): DiscordCapability => {
  const access: AdapterAccess = {
    encodeThreadId: (input) => discord.encodeThreadId(input),
    fetchMessages: (threadId, options) => discord.fetchMessages(threadId, options),
    fridayFetchMessage: (threadId, messageId) => discord.fridayFetchMessage(threadId, messageId),
    addReaction: (threadId, messageId, emoji) => discord.addReaction(threadId, messageId, emoji),
    removeReaction: (threadId, messageId, emoji) =>
      discord.removeReaction(threadId, messageId, emoji),
    api: (path, method, body) => discord.fridayDiscordRequest(path, method, body),
  }
  const encodeEndpoint = (endpoint: DiscordLinkSourceEndpoint) => {
    const location: DiscordThreadId = {
      guildId: endpoint.guildId,
      channelId: endpoint.conversationId,
    }
    if (endpoint.kind === 'thread') location.threadId = endpoint.conversationId
    return access.encodeThreadId(location)
  }
  const reaction = (
    operation: 'add' | 'remove',
    endpoint: DiscordLinkSourceEndpoint,
    messageId: string,
    emoji: string,
  ) =>
    Effect.tryPromise({
      try: () =>
        operation === 'add'
          ? access.addReaction(encodeEndpoint(endpoint), messageId, emoji)
          : access.removeReaction(encodeEndpoint(endpoint), messageId, emoji),
      catch: (cause) =>
        new DiscordCapabilityError({
          operation: 'discord-api',
          connectionId,
          detail: `Could not ${operation} Discord reaction.`,
          cause,
        }),
    })
  return {
    connectionId,
    encodeEndpoint,
    addReaction: (endpoint, messageId, emoji) => reaction('add', endpoint, messageId, emoji),
    removeReaction: (endpoint, messageId, emoji) => reaction('remove', endpoint, messageId, emoji),
    fetchContext: (endpoint, messageId, limit) =>
      Effect.tryPromise({
        try: async () => {
          const threadId = encodeEndpoint(endpoint)
          const [trigger, prior] = await Promise.all([
            access.fridayFetchMessage(threadId, messageId),
            access.fetchMessages(threadId, { limit: Math.max(0, limit - 1), cursor: messageId }),
          ])
          return [
            ...new Map(
              [...prior.messages, trigger].map((message) => [message.id, message]),
            ).values(),
          ]
        },
        catch: (cause) =>
          new DiscordCapabilityError({
            operation: 'discord-api',
            connectionId,
            detail: 'Could not fetch the linked source trigger and prior context.',
            cause,
          }),
      }).pipe(
        Effect.map((messages) =>
          messages
            .map((message) => ({
              id: message.id,
              text: message.text,
              author: {
                userId: message.author.userId,
                userName: message.author.userName,
                fullName: message.author.fullName,
              },
              sentAt: safeIsoDateTime(message.metadata.dateSent),
              replyTo:
                message.replyTo === undefined
                  ? undefined
                  : {
                      id: message.replyTo.id,
                      text: message.replyTo.text,
                      author: {
                        userId: message.replyTo.author.userId,
                        userName: message.replyTo.author.userName,
                        fullName: message.replyTo.author.fullName,
                      },
                      sentAt: safeIsoDateTime(message.replyTo.metadata.dateSent),
                      attachments: [],
                    },
              attachments: message.attachments.map((attachment) => ({
                name: attachment.name ?? 'attachment',
                url: attachment.url ?? '',
                contentType: attachment.mimeType,
                size: attachment.size,
              })),
            }))
            .filter(
              (message) =>
                message.id === messageId ||
                message.text.length > 0 ||
                message.attachments.length > 0,
            ),
        ),
      ),
    createStandaloneThread: (endpoint, title) =>
      apiEffect(connectionId, access, `/channels/${targetChannelId(endpoint)}/threads`, 'POST', {
        name: title,
        type: 11,
        auto_archive_duration: 1440,
      }).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) =>
              new DiscordCapabilityError({
                operation: 'decode',
                connectionId,
                detail: 'Could not decode created Discord thread.',
                cause,
              }),
          }),
        ),
        Effect.flatMap((value) =>
          decodeDiscordApiChannel(value).pipe(
            Effect.mapError(
              (cause) =>
                new DiscordCapabilityError({
                  operation: 'decode',
                  connectionId,
                  detail: 'Could not decode created Discord thread.',
                  cause,
                }),
            ),
          ),
        ),
        Effect.map((channel) => ({
          id: channel.id,
          conversationId: discord.encodeThreadId({
            guildId: endpoint.guildId,
            channelId: endpoint.conversationId,
            threadId: channel.id,
          }),
        })),
      ),
    postSafe: (endpoint, message, mentionUserIds) =>
      apiEffect(connectionId, access, `/channels/${targetChannelId(endpoint)}/messages`, 'POST', {
        content: message,
        allowed_mentions: { parse: [], users: [...mentionUserIds], roles: [], replied_user: false },
      }).pipe(
        Effect.flatMap((response) =>
          Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) =>
              new DiscordCapabilityError({
                operation: 'decode',
                connectionId,
                detail: 'Could not decode Discord message.',
                cause,
              }),
          }),
        ),
        Effect.flatMap((value) =>
          decodeDiscordApiMessage(value).pipe(
            Effect.mapError(
              (cause) =>
                new DiscordCapabilityError({
                  operation: 'decode',
                  connectionId,
                  detail: 'Could not decode Discord message.',
                  cause,
                }),
            ),
          ),
        ),
        Effect.map(({ id }) => ({ messageId: id })),
      ),
    verifyMember: (guildId, userId) =>
      apiEffect(connectionId, access, `/guilds/${guildId}/members/${userId}`, 'GET').pipe(
        Effect.as(true),
        Effect.catch((error) =>
          error.status === 404 ? Effect.succeed(false) : Effect.fail(error),
        ),
      ),
  }
}
