import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

export class DiscordCommandRegistrationError extends Schema.Error<DiscordCommandRegistrationError>(
  'DiscordCommandRegistrationError',
)({
  _tag: Schema.tag('DiscordCommandRegistrationError'),
  operation: Schema.Literals(['register-global-command']),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Discord command registration failed: ${this.detail}`
  }
}

// SUB_COMMAND options (type 1) must not carry `required`; Discord rejects the payload.
const DiscordSubcommandOption = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  type: Schema.Literal(1),
})

const DiscordCommandDefinition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  options: Schema.Array(DiscordSubcommandOption),
})

const DiscordExistingCommand = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

const decodeCommandDefinition = Schema.decodeSync(DiscordCommandDefinition)
const decodeExistingCommands = Schema.decodeUnknownSync(Schema.Array(DiscordExistingCommand))

/**
 * Global application command definitions Friday registers for its application.
 * `/friday reload` reloads configuration; `/harness reload` reloads the Pi
 * harness session of the invoking thread's existing runtime.
 */
export const globalCommandDefinitions = [
  decodeCommandDefinition({
    name: 'friday',
    description: 'Friday application commands.',
    options: [
      {
        name: 'reload',
        description: 'Reload Friday configuration from the database.',
        type: 1,
      },
    ],
  }),
  decodeCommandDefinition({
    name: 'harness',
    description: 'Friday harness commands.',
    options: [
      {
        name: 'reload',
        description: 'Reload the harness extensions for this thread.',
        type: 1,
      },
    ],
  }),
]

/** Back-compat single-command definition; kept as the first global definition. */
export const fridayCommandDefinition = globalCommandDefinitions[0]

/**
 * Registers Friday's global application commands without touching any other
 * command the application may have: it fetches the existing global commands,
 * then creates each missing command via POST and updates each present command
 * via PATCH by command ID — never a bulk overwrite, so unrelated commands and
 * other deployments are untouched. Both endpoints are idempotent for Friday's
 * definitions, so repeated starts never duplicate commands.
 */
export const registerGlobalDiscordCommands = Effect.fn('registerGlobalDiscordCommands')(
  function* (options: {
    readonly botToken: string
    readonly applicationId: string
    readonly apiUrl?: string
  }) {
    const apiUrl = options.apiUrl ?? 'https://discord.com/api/v10'
    const commandsUrl = `${apiUrl}/applications/${options.applicationId}/commands`
    const headers = {
      Authorization: `Bot ${options.botToken}`,
      'Content-Type': 'application/json',
    }
    const fail = (detail: string, cause?: unknown) =>
      new DiscordCommandRegistrationError({
        operation: 'register-global-command',
        detail,
        cause,
      })

    const existingCommands = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(commandsUrl, { headers })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        // The listing is untrusted HTTP data; parse it strictly at the boundary.
        return decodeExistingCommands(await response.json())
      },
      catch: (cause) => fail("Could not list the application's existing global commands.", cause),
    })

    for (const definition of globalCommandDefinitions) {
      // Discord rejects duplicate names on create, so update the matching
      // command by ID; POST is only used when no command with the name exists.
      const existing = existingCommands.find((command) => command.name === definition.name)
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(existing === undefined ? commandsUrl : `${commandsUrl}/${existing.id}`, {
            method: existing === undefined ? 'POST' : 'PATCH',
            headers,
            body: JSON.stringify(definition),
          }),
        catch: (cause) => fail('Discord command registration request failed.', cause),
      })
      if (!response.ok) {
        return yield* fail(`Discord command registration failed: HTTP ${response.status}`)
      }
      yield* Effect.logInfo('discord.command.registered').pipe(
        Effect.annotateLogs({
          component: 'discord',
          applicationId: options.applicationId,
          command: definition.name,
          created: existing === undefined,
        }),
      )
    }
  },
)
