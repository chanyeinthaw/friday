/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- The bypass test narrows the adapter config to the policy callbacks routing reads. */
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import { FridayDiscordAdapter, type FridayDiscordAdapterConfig } from './FridayDiscordAdapter.ts'

const CHANNEL = '222222222222222222'

class BypassAdapter extends FridayDiscordAdapter {
  readonly requests: Array<{ path: string; method: string }> = []

  constructor(replyInChannel: boolean) {
    super({
      botToken: 'bot-token',
      applicationId: 'application-1',
      publicKey: 'public-key',
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-thread',
        users: { mode: 'all', ids: [] },
      }),
      replyInChannelChannelIds: () => (replyInChannel ? [CHANNEL] : []),
    } as FridayDiscordAdapterConfig)
  }

  protected override discordFetch(path: string, method: string): Promise<Response> {
    this.requests.push({ path, method })
    return Promise.resolve(
      new Response(JSON.stringify({ id: '999999999999999999', name: 'Routed' }), { status: 200 }),
    )
  }

  runSuppressed(channelId: string, messageId: string): Promise<{ id: string; name: string }> {
    return super.createDiscordThread(channelId, messageId)
  }
}

it.effect('preserves reply-in-channel suppression for the normal path', () =>
  Effect.promise(async () => {
    const discord = new BypassAdapter(true)
    const suppressed = await discord.runSuppressed(CHANNEL, 'message-1')
    assert.deepStrictEqual(suppressed, { id: CHANNEL, name: CHANNEL })
    assert.deepStrictEqual(discord.requests, [])
  }),
)

it.effect('creates a native thread through the explicit routing path without retrying', () =>
  Effect.promise(async () => {
    const discord = new BypassAdapter(true)
    const created = await discord.createRoutedDiscordThread(CHANNEL, 'message-1')
    assert.strictEqual(created.id, '999999999999999999')
    // Single Discord call: the routing path never blindly retries.
    assert.deepStrictEqual(discord.requests, [
      { path: `/channels/${CHANNEL}/messages/message-1/threads`, method: 'POST' },
    ])
  }),
)
