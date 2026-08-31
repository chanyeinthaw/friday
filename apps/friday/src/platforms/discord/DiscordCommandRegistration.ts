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

export const fridayCommandDefinition = decodeCommandDefinition({
  name: 'friday',
  description: 'Friday application commands.',
  options: [
    {
      name: 'reload',
      description: 'Reload Friday configuration from the database.',
      type: 1,
    },
  ],
})

/**
 * Registers `/friday` (with its `reload` subcommand) as a global application
 * command without touching any other command the application may have:
 * it fetches the existing global commands, then creates the command via POST
 * when missing or updates the matching command via PATCH when present. Both
 * endpoints are idempotent for Friday's definition, so repeated starts never
 * duplicate commands and unrelated commands are never overwritten.
 */
export const registerGlobalFridayCommand = Effect.fn('registerGlobalFridayCommand')(
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

    // Discord rejects duplicate names on create, so update the matching command
    // by ID; POST is only used when no `friday` command exists yet.
    const existingFriday = existingCommands.find(
      (command) => command.name === fridayCommandDefinition.name,
    )
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(existingFriday === undefined ? commandsUrl : `${commandsUrl}/${existingFriday.id}`, {
          method: existingFriday === undefined ? 'POST' : 'PATCH',
          headers,
          body: JSON.stringify(fridayCommandDefinition),
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
        command: fridayCommandDefinition.name,
        created: existingFriday === undefined,
      }),
    )
  },
)
