import { DiscordAdapter } from '@chat-adapter/discord'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { rejects } from 'node:assert/strict'

type DiscordResponse = ReadonlyArray<never> | { readonly id: string; readonly parent_id: string }

class RecordingDiscordAdapter extends DiscordAdapter {
  readonly requests: Array<{ readonly path: string; readonly method: string }> = []
  private readonly responseFor: (path: string, method: string) => DiscordResponse

  constructor(responseFor: (path: string, method: string) => DiscordResponse = () => []) {
    super({
      botToken: 'bot-token',
      applicationId: 'application-1',
      publicKey: 'public-key',
    })
    this.responseFor = responseFor
  }

  protected override discordFetch(path: string, method: string): Promise<Response> {
    this.requests.push({ path, method })
    return Promise.resolve(Response.json(this.responseFor(path, method)))
  }
}

const topLevelConversation = 'discord:guild-1:channel-1:channel-1'
const childThreadConversation = 'discord:guild-1:channel-1:thread-1'

it.effect('resolves the equal channel/thread sentinel directly to the top-level channel', () =>
  Effect.gen(function* () {
    const discord = new RecordingDiscordAdapter()

    yield* Effect.promise(() => discord.fetchMessages(topLevelConversation, { limit: 20 }))

    assert.deepStrictEqual(discord.requests, [
      { path: '/channels/channel-1/messages?limit=20', method: 'GET' },
    ])
  }),
)

it.effect('still validates a real child thread against its parent before fetching messages', () =>
  Effect.gen(function* () {
    const discord = new RecordingDiscordAdapter((path) =>
      path === '/channels/thread-1' ? { id: 'thread-1', parent_id: 'channel-1' } : [],
    )

    yield* Effect.promise(() => discord.fetchMessages(childThreadConversation, { limit: 20 }))

    assert.deepStrictEqual(discord.requests, [
      { path: '/channels/thread-1', method: 'GET' },
      { path: '/channels/thread-1/messages?limit=20', method: 'GET' },
    ])
  }),
)

it.effect('still rejects a child thread whose resolved parent does not match', () =>
  Effect.gen(function* () {
    const discord = new RecordingDiscordAdapter(() => ({
      id: 'thread-1',
      parent_id: 'other-channel',
    }))

    yield* Effect.promise(() =>
      rejects(
        discord.fetchMessages(childThreadConversation, { limit: 20 }),
        /Discord thread thread-1 does not belong to channel channel-1/,
      ),
    )
    assert.deepStrictEqual(discord.requests, [{ path: '/channels/thread-1', method: 'GET' }])
  }),
)

it.effect('keeps malformed conversation ID behavior unchanged', () =>
  Effect.gen(function* () {
    const discord = new RecordingDiscordAdapter()

    yield* Effect.promise(() => rejects(discord.fetchMessages('not-a-discord-id', { limit: 20 })))
    assert.deepStrictEqual(discord.requests, [])
  }),
)
