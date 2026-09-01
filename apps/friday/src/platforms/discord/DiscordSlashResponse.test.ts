/* oxlint-disable anti-slop/no-unknown-parameters -- The overrides mirror the adapter's declared protected HTTP-boundary signatures (body?: unknown); recording the raw body is the point of the test double. */

import { DiscordInteractionResponseFlag } from '@chat-adapter/discord'
import type {
  DiscordInteractionFlagsContext,
  DiscordInteractionResponseFlags,
} from '@chat-adapter/discord'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { Chat } from 'chat'

import { FRIDAY_COMMAND_PATHS } from './DiscordSlashCommand.ts'
import { FridayDiscordAdapter } from './FridayDiscordAdapter.ts'

interface RecordedRequest {
  readonly kind: 'interaction' | 'channel'
  readonly path: string
  readonly method: string
  readonly body: unknown
}

const okJson = () => new Response(JSON.stringify({ id: 'message-1' }), { status: 200 })

/**
 * Recording adapter that stubs both Discord HTTP boundaries so the test can
 * observe exactly which Discord API call completes the slash-command reply.
 */
class RecordingFridayDiscordAdapter extends FridayDiscordAdapter {
  readonly requests: Array<RecordedRequest> = []

  constructor() {
    super({
      botToken: 'bot-token',
      applicationId: 'application-1',
      publicKey: 'public-key',
      // The adapter drops unconfigured locations before Friday ever sees them;
      // the test dispatches a configured one.
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-thread',
        users: { mode: 'all', ids: [] },
      }),
      replyInChannelChannelIds: () => [],
      // The same interactionFlags wiring DiscordLive installs for /friday.
      interactionFlags: (context) =>
        FRIDAY_COMMAND_PATHS.includes(context.command)
          ? DiscordInteractionResponseFlag.Ephemeral
          : undefined,
    })
  }

  protected override discordInteractionFetch(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<Response> {
    this.requests.push({ kind: 'interaction', path, method, body })
    return Promise.resolve(okJson())
  }

  protected override discordFetch(path: string, method: string, body?: unknown): Promise<Response> {
    this.requests.push({ kind: 'channel', path, method, body })
    return Promise.resolve(okJson())
  }

  /** Exposes the protected gateway interaction entry point for the test. */
  runApplicationCommand(
    context: DiscordInteractionFlagsContext,
    flags: DiscordInteractionResponseFlags,
    options: { readonly waitUntil: (task: Promise<unknown>) => void },
  ): void {
    // SAFETY: only the interaction token is read on this path; the test payload
    // carries every field the adapter's slash-response machinery touches.
    super.handleApplicationCommandInteraction(context, flags, options as never)
  }
}

it.effect('completes the interaction webhook original response through channel.post', () =>
  Effect.promise(async () => {
    const discord = new RecordingFridayDiscordAdapter()
    const chat = new Chat({
      userName: 'Friday',
      // SAFETY: only slash-command dispatch is exercised; the state adapter is
      // never invoked because channel history persistence is not configured.
      adapters: { discord: discord as never },
      // SAFETY: the slash-command dispatch under test never reads or writes
      // state; an empty record satisfies the constructor without a database.
      state: {} as never,
      concurrency: 'concurrent',
    })
    await discord.initialize(chat)
    const posted: Array<Promise<unknown>> = []
    chat.onSlashCommand(FRIDAY_COMMAND_PATHS, (event) => {
      // The production reply path: event.channel.post, not postEphemeral.
      posted.push(event.channel.post('Configuration reloaded (version 2).').then(() => undefined))
    })
    const tasks: Array<Promise<unknown>> = []
    discord.runApplicationCommand(
      {
        channelId: 'discord:guild-1:channel-1',
        command: '/friday',
        // SAFETY: the interaction token drives the webhook path under test;
        // only `token` is read from the interaction on this code path.
        interaction: { token: 'interaction-token' } as never,
        text: '',
        user: {
          id: 'admin-1',
          username: 'admin',
          discriminator: '0001',
          global_name: 'admin',
          bot: false,
        },
      },
      DiscordInteractionResponseFlag.Ephemeral,
      { waitUntil: (task) => tasks.push(task) },
    )
    await Promise.all(tasks)
    await Promise.all(posted)
    const interaction = discord.requests.filter((request) => request.kind === 'interaction')
    assert.strictEqual(interaction.length, 1)
    assert.strictEqual(interaction[0]?.method, 'PATCH')
    assert.strictEqual(
      interaction[0]?.path,
      '/webhooks/application-1/interaction-token/messages/@original',
    )
    // SAFETY: the recorded body is the JSON this test's fake Response produced
    // (content plus optional flags), not untrusted I/O.
    const body = interaction[0]?.body as { content?: string; flags?: number }
    assert.strictEqual(body.content, 'Configuration reloaded (version 2).')
    // The PATCH omits flags, so the ephemeral flag set at deferReply is
    // preserved instead of being cleared by the completion.
    assert.strictEqual(body.flags, undefined)
    // The reply went to the interaction webhook, never to the channel itself.
    assert.strictEqual(
      discord.requests.some((request) => request.kind === 'channel'),
      false,
    )
  }),
)
