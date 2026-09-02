/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- SQL rows are decoded immediately through Effect Schema. */

import { PlatformConnectionId } from '@friday/contracts/conversation'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runStructuralMigrations } from '../persistence/Migrations.ts'

const DiscordSnowflake = Schema.String.pipe(
  Schema.check(Schema.isTrimmed()),
  Schema.check(Schema.isPattern(/^[1-9][0-9]{16,19}$/)),
)

export const DiscordLinkId = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isNonEmpty()),
  Schema.brand('DiscordLinkId'),
)
export type DiscordLinkId = typeof DiscordLinkId.Type

export const DiscordConversationKind = Schema.Literals(['channel', 'thread'])
export type DiscordConversationKind = typeof DiscordConversationKind.Type

const DiscordEndpointFields = {
  connectionId: PlatformConnectionId,
  guildId: DiscordSnowflake,
  conversationId: DiscordSnowflake,
} as const

export const DiscordLinkSourceEndpoint = Schema.Struct({
  ...DiscordEndpointFields,
  kind: DiscordConversationKind,
})
export type DiscordLinkSourceEndpoint = typeof DiscordLinkSourceEndpoint.Type

export const DiscordLinkDestinationEndpoint = Schema.Struct({
  ...DiscordEndpointFields,
  kind: Schema.Literal('channel'),
})
export type DiscordLinkDestinationEndpoint = typeof DiscordLinkDestinationEndpoint.Type

export const DiscordLinkEndpoint = DiscordLinkSourceEndpoint
export type DiscordLinkEndpoint = DiscordLinkSourceEndpoint

export const DiscordLink = Schema.Struct({
  id: DiscordLinkId,
  enabled: Schema.Boolean,
  source: DiscordLinkSourceEndpoint,
  destination: DiscordLinkDestinationEndpoint,
})
export type DiscordLink = typeof DiscordLink.Type

export class DiscordLinkError extends Schema.Error<DiscordLinkError>('DiscordLinkError')({
  _tag: Schema.tag('DiscordLinkError'),
  operation: Schema.Literals(['read', 'write', 'invalid']),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type DiscordLinkMutationOutcome =
  | 'updated'
  | 'missing'
  | 'already-enabled'
  | 'already-disabled'

export interface DiscordLinksContract {
  readonly set: (link: DiscordLink) => Effect.Effect<'updated', DiscordLinkError>
  readonly get: (id: DiscordLinkId) => Effect.Effect<DiscordLink | undefined, DiscordLinkError>
  readonly list: () => Effect.Effect<ReadonlyArray<DiscordLink>, DiscordLinkError>
  readonly enable: (
    id: DiscordLinkId,
  ) => Effect.Effect<DiscordLinkMutationOutcome, DiscordLinkError>
  readonly disable: (
    id: DiscordLinkId,
  ) => Effect.Effect<DiscordLinkMutationOutcome, DiscordLinkError>
  readonly remove: (id: DiscordLinkId) => Effect.Effect<'removed' | 'missing', DiscordLinkError>
}

export class DiscordLinks extends Context.Service<DiscordLinks, DiscordLinksContract>()(
  'friday/config/DiscordLinks',
) {}

const Row = Schema.Struct({
  link_id: Schema.String,
  enabled: Schema.Number,
  source_connection_id: Schema.String,
  source_guild_id: Schema.String,
  source_conversation_id: Schema.String,
  source_kind: DiscordConversationKind,
  destination_connection_id: Schema.String,
  destination_guild_id: Schema.String,
  destination_conversation_id: Schema.String,
  destination_kind: Schema.Literal('channel'),
})
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row))
const decodeLink = Schema.decodeUnknownEffect(DiscordLink)
const isDiscordLinkError = Schema.is(DiscordLinkError)

const fromRow = (row: typeof Row.Type) =>
  decodeLink({
    id: row.link_id,
    enabled: row.enabled === 1,
    source: {
      connectionId: row.source_connection_id,
      guildId: row.source_guild_id,
      conversationId: row.source_conversation_id,
      kind: row.source_kind,
    },
    destination: {
      connectionId: row.destination_connection_id,
      guildId: row.destination_guild_id,
      conversationId: row.destination_conversation_id,
      kind: row.destination_kind,
    },
  })

export const validateDiscordLink = (link: DiscordLink, links: ReadonlyArray<DiscordLink>) => {
  if (
    link.source.connectionId === link.destination.connectionId &&
    link.source.guildId === link.destination.guildId &&
    link.source.conversationId === link.destination.conversationId
  ) {
    return Effect.fail(
      new DiscordLinkError({
        operation: 'invalid',
        detail: 'Source and destination are identical.',
      }),
    )
  }
  const duplicate = links.find(
    (candidate) =>
      candidate.id !== link.id &&
      candidate.source.connectionId === link.source.connectionId &&
      candidate.source.guildId === link.source.guildId &&
      candidate.source.conversationId === link.source.conversationId,
  )
  return duplicate === undefined
    ? Effect.void
    : Effect.fail(
        new DiscordLinkError({
          operation: 'invalid',
          detail: `Source is already assigned to link ${duplicate.id}.`,
        }),
      )
}

export const DiscordLinksLive = Layer.effect(
  DiscordLinks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* runStructuralMigrations().pipe(Effect.orDie)
    const read = Effect.fn('DiscordLinks.list')(function* () {
      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM discord_links ORDER BY link_id`
      const decoded = yield* decodeRows(rows)
      return yield* Effect.forEach(decoded, fromRow)
    })
    const requireDiscordEndpoint = Effect.fn('DiscordLinks.requireEndpoint')(function* (
      endpoint: DiscordLinkSourceEndpoint | DiscordLinkDestinationEndpoint,
    ) {
      const rows = yield* sql<{ readonly platform: string; readonly enabled: number }>`
        SELECT platform_connections.platform, platform_connections.enabled
        FROM platform_connections
        JOIN discord_connections USING (connection_id)
        WHERE platform_connections.connection_id = ${endpoint.connectionId}
      `
      if (rows[0]?.platform !== 'discord' || rows[0].enabled !== 1) {
        return yield* new DiscordLinkError({
          operation: 'invalid',
          detail: `Discord connection ${endpoint.connectionId} is missing or disabled.`,
        })
      }
      const guilds = yield* sql<{ readonly enabled: number }>`
        SELECT enabled FROM discord_guilds
        WHERE connection_id = ${endpoint.connectionId} AND guild_id = ${endpoint.guildId}
      `
      if (guilds[0]?.enabled !== 1) {
        return yield* new DiscordLinkError({
          operation: 'invalid',
          detail: `Guild ${endpoint.guildId} is missing or disabled on ${endpoint.connectionId}.`,
        })
      }
    })
    const list = () =>
      read().pipe(
        Effect.mapError(
          (cause) =>
            new DiscordLinkError({
              operation: 'read',
              detail: 'Could not read Discord links.',
              cause,
            }),
        ),
      )
    const set = Effect.fn('DiscordLinks.set')(function* (link: DiscordLink) {
      yield* requireDiscordEndpoint(link.source)
      yield* requireDiscordEndpoint(link.destination)
      yield* validateDiscordLink(link, yield* list())
      yield* sql`
        INSERT INTO discord_links (
          link_id, enabled, source_connection_id, source_guild_id, source_conversation_id,
          source_kind, destination_connection_id, destination_guild_id,
          destination_conversation_id, destination_kind, updated_at
        ) VALUES (
          ${link.id}, ${link.enabled ? 1 : 0}, ${link.source.connectionId}, ${link.source.guildId},
          ${link.source.conversationId}, ${link.source.kind}, ${link.destination.connectionId},
          ${link.destination.guildId}, ${link.destination.conversationId}, ${link.destination.kind},
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(link_id) DO UPDATE SET
          enabled=excluded.enabled, source_connection_id=excluded.source_connection_id,
          source_guild_id=excluded.source_guild_id, source_conversation_id=excluded.source_conversation_id,
          source_kind=excluded.source_kind, destination_connection_id=excluded.destination_connection_id,
          destination_guild_id=excluded.destination_guild_id,
          destination_conversation_id=excluded.destination_conversation_id,
          destination_kind=excluded.destination_kind, updated_at=CURRENT_TIMESTAMP
      `
      return 'updated' as const
    })
    const toggle = (id: DiscordLinkId, enabled: boolean) =>
      Effect.gen(function* () {
        const found = (yield* list()).find((link) => link.id === id)
        if (found === undefined) return 'missing' as const
        if (found.enabled === enabled)
          return enabled ? ('already-enabled' as const) : ('already-disabled' as const)
        yield* sql`UPDATE discord_links SET enabled=${enabled ? 1 : 0}, updated_at=CURRENT_TIMESTAMP WHERE link_id=${id}`
        return 'updated' as const
      }).pipe(
        Effect.mapError((cause) =>
          isDiscordLinkError(cause)
            ? cause
            : new DiscordLinkError({
                operation: 'write',
                detail: 'Could not update Discord link.',
                cause,
              }),
        ),
      )
    return DiscordLinks.of({
      set: (link) =>
        set(link).pipe(
          Effect.mapError((cause) =>
            isDiscordLinkError(cause)
              ? cause
              : new DiscordLinkError({
                  operation: 'write',
                  detail: 'Could not store Discord link.',
                  cause,
                }),
          ),
        ),
      get: (id) => list().pipe(Effect.map((links) => links.find((link) => link.id === id))),
      list,
      enable: (id) => toggle(id, true),
      disable: (id) => toggle(id, false),
      remove: (id) =>
        sql<
          Record<string, unknown>
        >`DELETE FROM discord_links WHERE link_id=${id} RETURNING *`.pipe(
          Effect.flatMap(decodeRows),
          Effect.map((rows) => (rows.length === 1 ? ('removed' as const) : ('missing' as const))),
          Effect.mapError(
            (cause) =>
              new DiscordLinkError({
                operation: 'write',
                detail: 'Could not remove Discord link.',
                cause,
              }),
          ),
        ),
    })
  }),
)
