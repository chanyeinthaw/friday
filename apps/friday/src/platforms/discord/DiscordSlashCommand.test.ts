import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Chat } from 'chat'

import {
  FRIDAY_COMMAND_PATHS,
  FRIDAY_COMMAND_NAME,
  FRIDAY_RELOAD_SUBCOMMAND,
  decodeFridayInteraction,
  decideFridayCommand,
  fridayCommandReply,
  fridayReloadReply,
  fridaySubcommand,
} from './DiscordSlashCommand.ts'
import { FridayDiscordAdapter } from './DiscordSystemChannelAdapter.ts'
import { reloadFailed, reloadSucceeded } from '../../config/ConfigReload.ts'

const admin = { discordUserIds: ['admin-1', 'admin-2'] }

it('extracts the reload subcommand from a normalized gateway interaction', () => {
  // A normalized gateway interaction payload; decode strips adapter-specific fields.
  assert.deepStrictEqual(
    Option.flatMap(
      decodeFridayInteraction({ data: { name: 'friday', options: [{ name: 'reload' }], type: 1 } }),
      fridaySubcommand,
    ),
    Option.some(FRIDAY_RELOAD_SUBCOMMAND),
  )
})

it('returns none for interactions without a subcommand', () => {
  assert(
    Option.isNone(
      Option.flatMap(decodeFridayInteraction({ data: { name: 'friday' } }), fridaySubcommand),
    ),
  )
  assert(Option.isNone(Option.flatMap(decodeFridayInteraction({}), fridaySubcommand)))
})

it('returns none for malformed or non-command interaction payloads', () => {
  assert(Option.isNone(Option.flatMap(decodeFridayInteraction(Symbol('bad')), fridaySubcommand)))
  assert(Option.isNone(Option.flatMap(decodeFridayInteraction(null), fridaySubcommand)))
})

it('authorizes reload for configured admin user IDs only', () => {
  assert.deepStrictEqual(
    decideFridayCommand({ subcommand: Option.some('reload'), userId: 'admin-1', admin }),
    { kind: 'reload' },
  )
  assert.deepStrictEqual(
    decideFridayCommand({ subcommand: Option.some('reload'), userId: 'random-user', admin }),
    { kind: 'unauthorized' },
  )
  // Authorization is an exact stable-ID match, never a prefix or alias.
  assert.deepStrictEqual(
    decideFridayCommand({ subcommand: Option.some('reload'), userId: 'admin-1 ', admin }),
    { kind: 'unauthorized' },
  )
})

it('answers unknown subcommands with usage guidance', () => {
  const decision = decideFridayCommand({
    subcommand: Option.some('dance'),
    userId: 'admin-1',
    admin,
  })
  if (decision.kind !== 'usage') throw new Error('expected a usage decision')
  assert.match(fridayCommandReply(decision), /Usage: \/friday reload/)
})

it('replies with the reload outcome', () => {
  assert.match(fridayReloadReply(reloadSucceeded(4)), /Configuration reloaded \(version 4\)\./)
  assert.match(fridayReloadReply(reloadFailed('bad config')), /bad config/)
})

/** Exposes the adapter's protected slash-command parsing for regression assertions. */
class TestableFridayDiscordAdapter extends FridayDiscordAdapter {
  commandPathFor(options: ReadonlyArray<{ readonly name: string }>): string {
    // SAFETY: the adapter's declared option type is structural; a subcommand
    // option's flattening only depends on its name and nested options.
    return super.parseSlashCommand(FRIDAY_COMMAND_NAME, options as never).command
  }
}

it('matches every command path the adapter produces for /friday reload', () => {
  const discord = new TestableFridayDiscordAdapter({
    botToken: 'bot-token',
    applicationId: 'application-1',
    publicKey: 'public-key',
    isAllowedLocation: () => true,
  })
  // Real gateway shape, verified against chat SDK 4.38: the no-argument
  // `reload` subcommand keeps the parent-only command path.
  const noArguments = discord.commandPathFor([{ name: FRIDAY_RELOAD_SUBCOMMAND }])
  assert.strictEqual(noArguments, '/friday')
  // Both the parent-only and subcommand-flattened shapes must be matched.
  assert.deepStrictEqual([...FRIDAY_COMMAND_PATHS], ['/friday', '/friday reload'])
  assert(FRIDAY_COMMAND_PATHS.includes(noArguments))
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

it.effect('dispatches /friday reload events to the registered handler', () =>
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
    chat.onSlashCommand(FRIDAY_COMMAND_PATHS, (event) => {
      handled.push(event.command)
    })
    const tasks: Array<Promise<unknown>> = []
    // The real no-argument invocation path (verified against chat SDK 4.38).
    chat.processSlashCommand(slashCommandEvent('/friday', { name: 'stub' }), {
      waitUntil: waitUntil(tasks),
    })
    // The subcommand-flattened path, should the SDK gain subcommand arguments.
    chat.processSlashCommand(slashCommandEvent('/friday reload', { name: 'stub' }), {
      waitUntil: waitUntil(tasks),
    })
    await Promise.all(tasks)
    assert.deepStrictEqual(handled, ['/friday', '/friday reload'])
  }),
)

it.effect('ignores commands outside the /friday paths', () =>
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
    chat.onSlashCommand(FRIDAY_COMMAND_PATHS, (event) => {
      handled.push(event.command)
    })
    const tasks: Array<Promise<unknown>> = []
    chat.processSlashCommand(slashCommandEvent('/unrelated', { name: 'stub' }), {
      waitUntil: waitUntil(tasks),
    })
    await Promise.all(tasks)
    assert.deepStrictEqual(handled, [])
  }),
)
