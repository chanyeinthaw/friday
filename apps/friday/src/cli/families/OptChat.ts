import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { OptChatBinding } from '../../config/AppConfig.ts'
import { FridayCliError } from '../Types.ts'
import type { CliBranchSpec } from '../Command.ts'

const decodeBinding = Schema.decodeUnknownEffect(OptChatBinding)
const invalid = (arguments_: ReadonlyArray<string>) =>
  new FridayCliError({ argument: arguments_.join(' ') })
export const optChatConfigCommand: CliBranchSpec = {
  name: 'optchat',
  summary: 'Bind a channel and owner to one endless OptChat memory.',
  children: [
    {
      name: 'list',
      summary: 'List OptChat bindings, including disabled bindings.',
      parse: (tokens, all) =>
        tokens.length === 0
          ? Effect.succeed({ type: 'config-optchat-list' as const })
          : Effect.fail(invalid(all)),
    },
    {
      name: 'add',
      summary: 'Add or re-enable an immutable channel and owner binding.',
      arguments: ['<memory-id> <discord|slack> <connection-id> <channel-id> <owner-user-id>'],
      parse: Effect.fn('Cli.parseOptChatAdd')(function* (tokens, all) {
        if (tokens.length !== 5) return yield* invalid(all)
        const [id, platform, connectionId, channelId, ownerUserId] = tokens
        const binding = yield* decodeBinding({
          id,
          platform,
          connectionId,
          channelId,
          ownerUserId,
        }).pipe(Effect.mapError(() => invalid(all)))
        return { type: 'config-optchat-add' as const, binding }
      }),
    },
    {
      name: 'disable',
      summary: 'Disable a binding without deleting its history.',
      arguments: ['<memory-id>'],
      parse: (tokens, all) =>
        tokens.length === 1 && tokens[0]?.trim()
          ? Effect.succeed({ type: 'config-optchat-disable' as const, id: tokens[0] })
          : Effect.fail(invalid(all)),
    },
  ],
}
