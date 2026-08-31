import { assert, it } from '@effect/vitest'
import * as Option from 'effect/Option'

import {
  FRIDAY_RELOAD_SUBCOMMAND,
  decodeFridayInteraction,
  decideFridayCommand,
  fridayCommandReply,
  fridayReloadReply,
  fridaySubcommand,
} from './DiscordSlashCommand.ts'
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
