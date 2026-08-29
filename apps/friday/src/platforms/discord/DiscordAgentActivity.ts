import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'

import type { PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

const activitySuffix = / ⚡️(?:x\d+)?$/u

export const makeDiscordAgentActivity = (
  discord: DiscordAdapter,
  botToken: string,
): ((input: PlatformAgentActivity) => Effect.Effect<void, ChatSdkPublicationError>) => {
  const baseNames = new Map<string, string>()
  const activeTaskIds = new Map<string, Set<string>>()

  return (input) =>
    Effect.tryPromise({
      try: async () => {
        const location = discord.decodeThreadId(String(input.binding.conversationId))
        if (!location.guildId) return
        let baseName = baseNames.get(location.guildId)
        if (!baseName) {
          const response = await fetch(
            `https://discord.com/api/v10/guilds/${location.guildId}/members/@me`,
            { headers: { Authorization: `Bot ${botToken}` } },
          )
          if (!response.ok) {
            throw new Error(`Discord bot member lookup failed: HTTP ${response.status}`)
          }
          // SAFETY: Discord's documented current-member response exposes optional nick and user fields.
          const member = (await response.json()) as {
            nick?: string | null
            user?: { username?: string }
          }
          baseName = (member.nick ?? member.user?.username ?? 'Friday').replace(activitySuffix, '')
          baseNames.set(location.guildId, baseName)
        }
        const tasks = activeTaskIds.get(location.guildId) ?? new Set<string>()
        if (input.active) tasks.add(input.taskId)
        else tasks.delete(input.taskId)
        activeTaskIds.set(location.guildId, tasks)
        const count = tasks.size
        const suffix = count === 0 ? '' : count === 1 ? ' ⚡️' : ` ⚡️x${count}`
        const nickname = `${baseName}${suffix}`.slice(0, 32)
        const response = await fetch(
          `https://discord.com/api/v10/guilds/${location.guildId}/members/@me`,
          {
            method: 'PATCH',
            headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ nick: nickname }),
          },
        )
        if (!response.ok)
          throw new Error(`Discord bot nickname update failed: HTTP ${response.status}`)
      },
      catch: (cause) => new ChatSdkPublicationError({ operation: 'set-agent-activity', cause }),
    })
}
