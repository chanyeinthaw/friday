import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'

import type { PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

const activitySuffix = / ⚡️(?:x\d+)?$/u
const DiscordCurrentUser = Schema.Struct({ id: Schema.String })
const DiscordGuildMember = Schema.Struct({
  nick: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.Struct({ username: Schema.optional(Schema.String) })),
})
const decodeCurrentUser = Schema.decodeUnknownPromise(DiscordCurrentUser)
const decodeGuildMember = Schema.decodeUnknownPromise(DiscordGuildMember)

interface GuildActivityState {
  readonly lock: Semaphore.Semaphore
  readonly activeTaskIds: Set<string>
  baseName: string | null
  users: number
}

export interface DiscordAgentActivityAdapter {
  decodeThreadId(threadId: string): { readonly guildId?: string | undefined }
}

export const makeDiscordAgentActivity = (
  discord: DiscordAgentActivityAdapter,
  botToken: string,
): ((input: PlatformAgentActivity) => Effect.Effect<void, ChatSdkPublicationError>) => {
  const guilds = new Map<string, GuildActivityState>()
  let botUserId: string | null = null
  let botUserLookup: Promise<string> | null = null

  const fetchBotUserId = (): Promise<string> => {
    if (botUserId !== null) return Promise.resolve(botUserId)
    if (botUserLookup !== null) return botUserLookup
    botUserLookup = fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${botToken}` },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Discord bot user lookup failed: HTTP ${response.status}`)
        }
        return response.json()
      })
      .then(decodeCurrentUser)
      .then((user) => {
        botUserId = user.id
        return user.id
      })
      .finally(() => {
        botUserLookup = null
      })
    return botUserLookup
  }

  const guildStateFor = (guildId: string): GuildActivityState => {
    const existing = guilds.get(guildId)
    if (existing) return existing
    const created: GuildActivityState = {
      lock: Semaphore.makeUnsafe(1),
      activeTaskIds: new Set(),
      baseName: null,
      users: 0,
    }
    guilds.set(guildId, created)
    return created
  }

  const updateGuild = (
    guildId: string,
    input: PlatformAgentActivity,
  ): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.suspend(() => {
      const state = guildStateFor(guildId)
      state.users += 1
      return state.lock
        .withPermit(
          Effect.tryPromise({
            try: async () => {
              const userId = await fetchBotUserId()
              if (state.baseName === null) {
                const response = await fetch(
                  `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
                  { headers: { Authorization: `Bot ${botToken}` } },
                )
                if (!response.ok) {
                  throw new Error(`Discord bot member lookup failed: HTTP ${response.status}`)
                }
                const member = await response.json().then(decodeGuildMember)
                state.baseName = (member.nick ?? member.user?.username ?? 'Friday').replace(
                  activitySuffix,
                  '',
                )
              }
              if (input.active) state.activeTaskIds.add(input.taskId)
              else state.activeTaskIds.delete(input.taskId)
              const count = state.activeTaskIds.size
              const suffix = count === 0 ? '' : count === 1 ? ' ⚡️' : ` ⚡️x${count}`
              const nickname = `${state.baseName}${suffix}`.slice(0, 32)
              const response = await fetch(
                `https://discord.com/api/v10/guilds/${guildId}/members/@me`,
                {
                  method: 'PATCH',
                  headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ nick: nickname }),
                },
              )
              if (!response.ok) {
                throw new Error(`Discord bot nickname update failed: HTTP ${response.status}`)
              }
              return { guildId, nickname, activeTaskCount: count }
            },
            catch: (cause) =>
              new ChatSdkPublicationError({ operation: 'set-agent-activity', cause }),
          }),
        )
        .pipe(
          Effect.tap((result) =>
            Effect.logInfo('discord.agent-activity.updated').pipe(Effect.annotateLogs(result)),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              state.users -= 1
              if (
                state.users === 0 &&
                state.activeTaskIds.size === 0 &&
                guilds.get(guildId) === state
              ) {
                guilds.delete(guildId)
              }
            }),
          ),
          Effect.asVoid,
        )
    })

  return (input) => {
    const location = discord.decodeThreadId(String(input.binding.conversationId))
    return location.guildId ? updateGuild(location.guildId, input) : Effect.void
  }
}
