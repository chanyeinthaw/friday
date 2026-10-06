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
    {
      name: 'import',
      summary: 'Import a Pi session JSONL transcript into an enabled OptChat memory.',
      arguments: ['<memory-id> <path> [--dry-run] [--json]'],
      parse: Effect.fn('Cli.parseOptChatImport')(function* (tokens, all) {
        if (tokens.length < 2) return yield* invalid(all)
        const [id, path, ...flags] = tokens
        if (
          id === undefined ||
          path === undefined ||
          id.trim() === '' ||
          path.trim() === '' ||
          id.startsWith('-') ||
          path.startsWith('-')
        ) {
          return yield* invalid(all)
        }
        const seen = new Set<string>()
        let dryRun = false
        let json = false
        for (const flag of flags) {
          if ((flag !== '--dry-run' && flag !== '--json') || seen.has(flag)) {
            return yield* invalid(all)
          }
          seen.add(flag)
          if (flag === '--dry-run') dryRun = true
          else json = true
        }
        return { type: 'config-optchat-import' as const, id, path, dryRun, json }
      }),
    },
  ],
}
