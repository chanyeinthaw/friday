/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/strict-effect-provide, anti-slop/no-unsafe-dictionary-type -- This vitest suite exercises the real SQLite boundary (node driver); SQL rows are decoded immediately through Effect Schema. */

import * as SqliteClient from '@effect/sql-sqlite-node/SqliteClient'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { runStructuralMigrations } from '../persistence/Migrations.ts'
import { DiscordLink, DiscordLinkError, DiscordLinks, DiscordLinksLive } from './DiscordLinks.ts'

const decodeLink = Schema.decodeSync(DiscordLink)
const decodeLinkEffect = Schema.decodeUnknownEffect(DiscordLink)
const decodeLinkId = Schema.decodeSync(DiscordLink.fields.id)
const isDiscordLinkError = Schema.is(DiscordLinkError)

const link = (overrides?: {
  readonly id?: string
  readonly sourceConversationId?: string
  readonly enabled?: boolean
}) =>
  decodeLink({
    id: overrides?.id ?? 'support-link',
    enabled: overrides?.enabled ?? true,
    source: {
      connectionId: 'discord-source',
      guildId: '11111111111111111',
      conversationId: overrides?.sourceConversationId ?? '22222222222222222',
      kind: 'thread',
    },
    destination: {
      connectionId: 'discord-ops',
      guildId: '33333333333333333',
      conversationId: '44444444444444444',
      kind: 'channel',
    },
  })

const SqlClientLive = SqliteClient.layer({ filename: ':memory:' })
const MigrationsLive = Layer.effectDiscard(runStructuralMigrations().pipe(Effect.orDie)).pipe(
  Layer.provide(SqlClientLive),
)
// provideMerge keeps the raw SqlClient available to the test effects while
// satisfying the store's own requirement.
const TestStack = DiscordLinksLive.pipe(
  Layer.provideMerge(Layer.mergeAll(SqlClientLive, MigrationsLive)),
)

/** Seeds one Discord connection with enabled guilds on both endpoints. */
const seedTopology = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const [index, connectionId] of ['discord-source', 'discord-ops'].entries()) {
    yield* sql`INSERT OR REPLACE INTO platform_connections (connection_id, platform, name, enabled, created_at, updated_at)
      VALUES (${connectionId}, 'discord', ${connectionId}, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    yield* sql`INSERT OR REPLACE INTO discord_connections (connection_id, application_id, public_key, bot_token_env, respond_to_global_mentions)
      VALUES (${connectionId}, ${`app-${index}`}, 'key', 'FRIDAY_DISCORD_TEST_TOKEN', 0)`
    for (const guildId of ['11111111111111111', '33333333333333333', '55555555555555555']) {
      yield* sql`INSERT OR REPLACE INTO discord_guilds (connection_id, guild_id, enabled, invocation_mode)
        VALUES (${connectionId}, ${guildId}, 1, 'mention-only')`
    }
  }
})

const setGuildEnabled = (connectionId: string, guildId: string, enabled: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE discord_guilds SET enabled=${enabled} WHERE connection_id=${connectionId} AND guild_id=${guildId}`
  })

const dropConnection = (connectionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM platform_connections WHERE connection_id=${connectionId}`
  })

const expectInvalid = (
  effect: Effect.Effect<unknown, DiscordLinkError>,
  detail: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect)
    assert.isTrue(result._tag === 'Failure', `expected failure: ${detail}`)
    if (result._tag === 'Failure') {
      assert.isTrue(isDiscordLinkError(result.failure))
      assert.include(result.failure.detail, detail)
    }
  })

it.effect('stores, reads, lists, toggles, and removes a link (removed vs missing)', () =>
  Effect.gen(function* () {
    yield* seedTopology
    const store = yield* DiscordLinks

    const supportLinkId = decodeLinkId('support-link')
    const missingLinkId = decodeLinkId('missing-link')
    assert.strictEqual(yield* store.set(link()), 'updated')
    assert.deepStrictEqual(yield* store.get(supportLinkId), link())

    assert.deepStrictEqual(yield* store.list(), [link()])
    assert.strictEqual(yield* store.get(missingLinkId), undefined)

    assert.strictEqual(yield* store.disable(supportLinkId), 'updated')
    assert.strictEqual(yield* store.disable(supportLinkId), 'already-disabled')
    assert.deepStrictEqual(yield* store.get(supportLinkId), link({ enabled: false }))
    assert.strictEqual(yield* store.enable(supportLinkId), 'updated')
    assert.strictEqual(yield* store.enable(supportLinkId), 'already-enabled')

    // Removing an existing link reports removed; a second attempt reports
    // missing because DELETE ... RETURNING yields no row.
    assert.strictEqual(yield* store.remove(supportLinkId), 'removed')
    assert.strictEqual(yield* store.remove(supportLinkId), 'missing')
    assert.strictEqual(yield* store.get(supportLinkId), undefined)
  }).pipe(Effect.provide(TestStack)),
)

it.effect('fully replaces a link on set', () =>
  Effect.gen(function* () {
    yield* seedTopology
    const store = yield* DiscordLinks

    yield* store.set(link())
    yield* store.set(link({ sourceConversationId: '66666666666666666' }))

    assert.deepStrictEqual(yield* store.list(), [
      link({ sourceConversationId: '66666666666666666' }),
    ])
  }).pipe(Effect.provide(TestStack)),
)

it.effect('rejects duplicate sources, self-links, and missing or disabled endpoints', () =>
  Effect.gen(function* () {
    yield* seedTopology
    const store = yield* DiscordLinks
    yield* store.set(link())

    yield* expectInvalid(
      store.set(link({ id: 'other-link' })),
      'Source is already assigned to link support-link.',
    )

    yield* expectInvalid(
      store.set(
        decodeLink({
          id: 'self-link',
          enabled: true,
          source: {
            connectionId: 'discord-source',
            guildId: '11111111111111111',
            conversationId: '22222222222222222',
            kind: 'channel',
          },
          destination: {
            connectionId: 'discord-source',
            guildId: '11111111111111111',
            conversationId: '22222222222222222',
            kind: 'channel',
          },
        }),
      ),
      'Source and destination are identical.',
    )

    yield* dropConnection('discord-ops')
    yield* expectInvalid(
      store.set(link({ id: 'missing-connection' })),
      'Discord connection discord-ops is missing or disabled.',
    )

    yield* seedTopology
    yield* setGuildEnabled('discord-ops', '33333333333333333', 0)

    yield* expectInvalid(
      store.set(link({ id: 'disabled-guild' })),
      'Guild 33333333333333333 is missing or disabled on discord-ops.',
    )
  }).pipe(Effect.provide(TestStack)),
)

it.effect('rejects a thread destination in v1', () =>
  Effect.gen(function* () {
    // The v1 destination must be a channel: Friday creates the operator thread
    // inside it, so the schema itself refuses a thread endpoint.
    const result = yield* Effect.result(
      decodeLinkEffect({
        id: 'thread-destination',
        enabled: true,
        source: {
          connectionId: 'discord-source',
          guildId: '11111111111111111',
          conversationId: '22222222222222222',
          kind: 'channel',
        },
        destination: {
          connectionId: 'discord-ops',
          guildId: '33333333333333333',
          conversationId: '44444444444444444',
          kind: 'thread',
        },
      }),
    )
    assert.isTrue(result._tag === 'Failure')
  }).pipe(Effect.provide(TestStack)),
)
