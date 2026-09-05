import {
  ChannelThread,
  PlatformConnectionId,
  PlatformConversationId,
} from '@friday/contracts/conversation'
import { assert, it } from '@effect/vitest'
import { Chat } from 'chat'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { reloadConversationHarness } from '../../conversation/HarnessReload.ts'
import {
  HARNESS_COMMAND_PATHS,
  HARNESS_COMMAND_NAME,
  HARNESS_RELOAD_SUBCOMMAND,
  decodeHarnessInteraction,
  decideHarnessCommand,
  harnessCommandReply,
  harnessReloadReply,
  harnessSubcommand,
} from './DiscordHarnessCommand.ts'
import { discordCanonicalConversationId } from './DiscordConversationScope.ts'
import { FridayDiscordAdapter } from './FridayDiscordAdapter.ts'
import {
  harnessReloadFailed,
  harnessReloadRefused,
  harnessReloadSucceeded,
} from '../../conversation/ThreadRuntime.ts'

it('extracts the reload subcommand from a normalized gateway interaction', () => {
  // A normalized gateway interaction payload; decode strips adapter-specific fields.
  assert.deepStrictEqual(
    Option.flatMap(
      decodeHarnessInteraction({
        data: { name: 'harness', options: [{ name: 'reload' }], type: 1 },
      }),
      harnessSubcommand,
    ),
    Option.some(HARNESS_RELOAD_SUBCOMMAND),
  )
})

it('returns none for interactions without a subcommand', () => {
  assert(
    Option.isNone(
      Option.flatMap(decodeHarnessInteraction({ data: { name: 'harness' } }), harnessSubcommand),
    ),
  )
  assert(Option.isNone(Option.flatMap(decodeHarnessInteraction({}), harnessSubcommand)))
})

it('returns none for malformed or non-command interaction payloads', () => {
  assert(Option.isNone(Option.flatMap(decodeHarnessInteraction(Symbol('bad')), harnessSubcommand)))
  assert(Option.isNone(Option.flatMap(decodeHarnessInteraction(null), harnessSubcommand)))
})

it('allows reload unconditionally — there is no authorization guard', () => {
  assert.deepStrictEqual(decideHarnessCommand({ subcommand: Option.some('reload') }), {
    kind: 'reload',
  })
})

it('answers unknown subcommands with usage guidance', () => {
  const decision = decideHarnessCommand({ subcommand: Option.some('dance') })
  if (decision.kind !== 'usage') throw new Error('expected a usage decision')
  assert.match(harnessCommandReply(decision), /Usage: \/harness reload/)
})

it('replies with the harness reload outcome', () => {
  assert.match(
    harnessReloadReply(harnessReloadSucceeded()),
    /Harness reloaded \(system prompt, extensions, and settings refreshed; conversation preserved\)\./,
  )
  assert.match(
    harnessReloadReply(harnessReloadRefused('busy', 'A turn is active in this thread.')),
    /Harness reload refused \(busy\): A turn is active in this thread\./,
  )
  assert.match(
    harnessReloadReply(harnessReloadFailed('extension exploded')),
    /Harness reload failed: extension exploded/,
  )
})

/** Exposes the adapter's protected slash-command parsing for regression assertions. */
class TestableFridayDiscordAdapter extends FridayDiscordAdapter {
  commandPathFor(options: ReadonlyArray<{ readonly name: string }>): string {
    // SAFETY: the adapter's declared option type is structural; a subcommand
    // option's flattening only depends on its name and nested options.
    return super.parseSlashCommand(HARNESS_COMMAND_NAME, options as never).command
  }
}

it('matches every command path the adapter produces for /harness reload', () => {
  const discord = new TestableFridayDiscordAdapter({
    botToken: 'bot-token',
    applicationId: 'application-1',
    publicKey: 'public-key',
    resolveChannelPolicy: () => ({
      invocationMode: 'mention-only',
      replyMode: 'reply-in-thread',
      users: { mode: 'all', ids: [] },
    }),
    replyInChannelChannelIds: () => [],
  })
  // Real gateway shape, verified against chat SDK 4.38: the no-argument
  // `reload` subcommand keeps the parent-only command path.
  const noArguments = discord.commandPathFor([{ name: HARNESS_RELOAD_SUBCOMMAND }])
  assert.strictEqual(noArguments, '/harness')
  // Both the parent-only and subcommand-flattened shapes must be matched.
  assert.deepStrictEqual([...HARNESS_COMMAND_PATHS], ['/harness', '/harness reload'])
  assert(HARNESS_COMMAND_PATHS.includes(noArguments))
})

const waitUntil = (tasks: Array<Promise<unknown>>) => (task: Promise<unknown>) => {
  tasks.push(task)
}

const slashCommandEvent = (command: string, adapter: { readonly name: string }) => ({
  command,
  text: '',
  user: { userId: 'admin-1', userName: 'admin', fullName: 'admin', isBot: false, isMe: false },
  // SAFETY: only slash-command dispatch is exercised; no adapter transport is used.
  adapter: adapter as never,
  raw: {},
  channelId: 'channel-1',
})

const decodeConnectionId = Schema.decodeSync(PlatformConnectionId)
const decodeConversationId = Schema.decodeSync(PlatformConversationId)
const persistedParentThread = Schema.decodeSync(ChannelThread)({
  id: 'thread-parent-channel',
  audience: 'user',
  parent: null,
  harness: 'pi',
  harnessSession: null,
  workingDirectory: '/tmp/friday/thread-parent-channel',
  model: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  thinkingLevel: 'max',
  channelContext: { name: 'Friday test channel', description: '' },
  conversationBinding: {
    platform: 'discord',
    connectionId: 'discord',
    channelId: 'discord:guild:channel',
    sourceMessageId: 'message-parent-channel',
    conversationId: 'discord:guild:channel:channel',
  },
  status: 'active',
  createdAt: '2026-03-21T09:00:00.000Z',
  updatedAt: '2026-03-21T09:00:00.000Z',
  closedAt: null,
})

it.effect('resolves a persisted parent-channel harness binding after canonicalization', () =>
  Effect.gen(function* () {
    const discord = new TestableFridayDiscordAdapter({
      botToken: 'bot-token',
      applicationId: 'application-1',
      publicKey: 'public-key',
      resolveChannelPolicy: () => ({
        invocationMode: 'mention-only',
        replyMode: 'reply-in-thread',
        users: { mode: 'all', ids: [] },
      }),
      replyInChannelChannelIds: () => [],
    })
    const persistedConversationId = decodeConversationId('discord:guild:channel:channel')
    const persisted = new Map([[String(persistedConversationId), persistedParentThread]])
    const reloadedThreadIds: Array<string> = []
    const outcome = yield* reloadConversationHarness({
      findThread: (lookup) =>
        Effect.succeed(Option.fromNullishOr(persisted.get(String(lookup.conversationId)))),
      reloadRuntime: (threadId) =>
        Effect.sync(() => {
          reloadedThreadIds.push(threadId)
          return harnessReloadSucceeded()
        }),
    })({
      platform: 'discord',
      connectionId: decodeConnectionId('discord'),
      conversationId: decodeConversationId(
        discordCanonicalConversationId(discord, 'discord:guild:channel'),
      ),
    })

    assert.deepStrictEqual(outcome, { ok: true })
    assert.deepStrictEqual(reloadedThreadIds, ['thread-parent-channel'])
  }),
)

it('keeps a normal child-thread application-command ID unchanged', () => {
  const discord = new TestableFridayDiscordAdapter({
    botToken: 'bot-token',
    applicationId: 'application-1',
    publicKey: 'public-key',
    resolveChannelPolicy: () => ({
      invocationMode: 'mention-only',
      replyMode: 'reply-in-thread',
      users: { mode: 'all', ids: [] },
    }),
    replyInChannelChannelIds: () => [],
  })

  assert.strictEqual(
    discordCanonicalConversationId(discord, 'discord:guild:channel:thread'),
    'discord:guild:channel:thread',
  )
})

it.effect('dispatches /harness reload events to the registered handler', () =>
  Effect.promise(async () => {
    const chat = new Chat({
      userName: 'Friday',
      // SAFETY: only slash-command dispatch is exercised; no adapter transport is used.
      adapters: { discord: { name: 'stub' } as never },
      // SAFETY: the state adapter is never invoked by this dispatch-only test.
      state: {} as never,
      concurrency: 'concurrent',
    })
    const handled: Array<string> = []
    chat.onSlashCommand(HARNESS_COMMAND_PATHS, (event) => {
      handled.push(event.command)
    })
    const tasks: Array<Promise<unknown>> = []
    // The real no-argument invocation path (verified against chat SDK 4.38).
    chat.processSlashCommand(slashCommandEvent('/harness', { name: 'stub' }), {
      waitUntil: waitUntil(tasks),
    })
    // The subcommand-flattened path, should the SDK gain subcommand arguments.
    chat.processSlashCommand(slashCommandEvent('/harness reload', { name: 'stub' }), {
      waitUntil: waitUntil(tasks),
    })
    await Promise.all(tasks)
    assert.deepStrictEqual(handled, ['/harness', '/harness reload'])
  }),
)

it.effect('ignores commands outside the /harness paths', () =>
  Effect.promise(async () => {
    const chat = new Chat({
      userName: 'Friday',
      // SAFETY: only slash-command dispatch is exercised; no adapter transport is used.
      adapters: { discord: { name: 'stub' } as never },
      // SAFETY: the state adapter is never invoked by this dispatch-only test.
      state: {} as never,
      concurrency: 'concurrent',
    })
    const handled: Array<string> = []
    chat.onSlashCommand(HARNESS_COMMAND_PATHS, (event) => {
      handled.push(event.command)
    })
    const tasks: Array<Promise<unknown>> = []
    chat.processSlashCommand(slashCommandEvent('/friday', { name: 'stub' }), {
      waitUntil: waitUntil(tasks),
    })
    await Promise.all(tasks)
    assert.deepStrictEqual(handled, [])
  }),
)
