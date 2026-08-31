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

const DiscordCommandDefinition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      type: Schema.Literal(1),
      required: Schema.Boolean,
    }),
  ),
})

export const fridayCommandDefinition = Schema.decodeUnknownSync(DiscordCommandDefinition)({
  name: 'friday',
  description: 'Friday application commands.',
  options: [
    {
      name: 'reload',
      description: 'Reload Friday configuration from the database.',
      type: 1,
      required: true,
    },
  ],
})

/**
 * Registers `/friday` as a global application command for the application.
 * Global registration means newly invited guilds get the command without
 * per-guild registration.
 */
export const registerGlobalFridayCommand = Effect.fn('registerGlobalFridayCommand')(
  function* (options: {
    readonly botToken: string
    readonly applicationId: string
    readonly apiUrl?: string
  }) {
    const apiUrl = options.apiUrl ?? 'https://discord.com/api/v10'
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(`${apiUrl}/applications/${options.applicationId}/commands`, {
          method: 'PUT',
          headers: {
            Authorization: `Bot ${options.botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify([fridayCommandDefinition]),
        }),
      catch: (cause) =>
        new DiscordCommandRegistrationError({
          operation: 'register-global-command',
          detail: 'Discord command registration request failed.',
          cause,
        }),
    })
    if (!response.ok) {
      return yield* new DiscordCommandRegistrationError({
        operation: 'register-global-command',
        detail: `Discord command registration failed: HTTP ${response.status}`,
      })
    }
    yield* Effect.logInfo('discord.command.registered').pipe(
      Effect.annotateLogs({
        component: 'discord',
        applicationId: options.applicationId,
        command: fridayCommandDefinition.name,
      }),
    )
  },
)
