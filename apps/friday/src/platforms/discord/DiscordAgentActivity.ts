import type { DiscordAdapter } from '@chat-adapter/discord'
import type * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'

import type { PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

const activitySuffix = / ⚡️(?:x\d+)?$/u
const discordApiBase = 'https://discord.com/api/v10'

/** Discord's documented application-description character limit. */
export const ApplicationDescriptionLimit = 400
/** Public activity line caps keep long prompts out of the global application description. */
export const ActivityLabelLimit = 64
export const ActivityChannelLimit = 32
const DescriptionDebounce: Duration.Input = '2 seconds'

export interface DiscordAgentActivityOptions {
  /** Publish active task activity to the Discord application description (default true). */
  readonly activityDescription?: boolean | undefined
  readonly descriptionDebounce?: Duration.Input | undefined
}

interface ActiveTask {
  readonly channelId: string
  readonly label: string
}

/**
 * Derives a concise single-line public label from a delegated task prompt.
 * Strips code fences, Discord mentions/timestamps, and Markdown markers so raw
 * prompts are never published verbatim.
 */
export const sanitizeTaskLabel = (task: string, maxLength: number = ActivityLabelLimit): string => {
  const prepared = task
    .replace(/```[\s\S]*?(?:```|$)/gu, ' ')
    .replace(/<(?:@!?|@&|#)\d+>/gu, ' ')
    .replace(/<t:\d+:[tTdDfFR]>/gu, ' ')
  const line =
    prepared
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0) ?? ''
  const label = line
    .replace(/`+/gu, '')
    .replace(/^[#>*\-–\s]+/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (label.length <= maxLength) return label
  return `${label.slice(0, maxLength - 1).trimEnd()}…`
}

const overflowText = (hidden: number): string =>
  hidden === 1 ? '... 1 more task.' : `... ${hidden} more tasks.`

// Discord measures description length in characters; count code points, not UTF-16 units.
const renderedLength = (lines: ReadonlyArray<string>): number =>
  lines.reduce((total, line) => total + Array.from(line).length + 1, -1)

/**
 * Packs activity lines into a description within the Discord limit, keeping only
 * complete lines and appending an accurate overflow count when tasks are hidden.
 */
export const packApplicationDescription = (
  lines: ReadonlyArray<string>,
  limit: number = ApplicationDescriptionLimit,
): string => {
  const overflowSegment = (hidden: number): ReadonlyArray<string> =>
    hidden > 0 ? [overflowText(hidden)] : []
  const lengthFor = (kept: number): number =>
    renderedLength([...lines.slice(0, kept), ...overflowSegment(lines.length - kept)])

  let kept = 0
  while (kept < lines.length && lengthFor(kept + 1) <= limit) kept += 1
  while (kept > 0 && lengthFor(kept) > limit) kept -= 1
  return [...lines.slice(0, kept), ...overflowSegment(lines.length - kept)].join('\n')
}

export const makeDiscordAgentActivity = (
  discord: Pick<DiscordAdapter, 'decodeThreadId'>,
  botToken: string,
  options: DiscordAgentActivityOptions = {},
): ((input: PlatformAgentActivity) => Effect.Effect<void, ChatSdkPublicationError>) => {
  const baseNames = new Map<string, string>()
  const activeTaskIds = new Map<string, Set<string>>()
  const channelNames = new Map<string, string>()
  const activeTasks = new Map<string, ActiveTask>()
  const describeActivity = options.activityDescription !== false
  let botUserId: string | null = null
  let lastDescription: string | null = null
  let scheduled: Fiber.Fiber<void, never> | null = null

  const channelName = (channelId: string): Effect.Effect<string, ChatSdkPublicationError> => {
    const cached = channelNames.get(channelId)
    if (cached !== undefined) return Effect.succeed(cached)
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${discordApiBase}/channels/${channelId}`, {
          headers: { Authorization: `Bot ${botToken}` },
        })
        if (!response.ok) {
          throw new Error(`Discord channel lookup failed: HTTP ${response.status}`)
        }
        // SAFETY: Discord's documented channel response exposes the optional name field.
        const channel = (await response.json()) as { name?: string | null }
        const name = channel.name ?? channelId
        channelNames.set(channelId, name)
        return name
      },
      catch: (cause) => new ChatSdkPublicationError({ operation: 'lookup-channel', cause }),
    })
  }

  const patchDescription = (description: string): Effect.Effect<void, ChatSdkPublicationError> =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${discordApiBase}/applications/@me`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ description }),
        })
        if (!response.ok) {
          throw new Error(`Discord application description update failed: HTTP ${response.status}`)
        }
      },
      catch: (cause) =>
        new ChatSdkPublicationError({ operation: 'set-application-description', cause }),
    })

  const publishDescription = Effect.gen(function* () {
    const names = new Map<string, string>()
    for (const channelId of new Set([...activeTasks.values()].map((task) => task.channelId))) {
      const name = yield* Effect.catch(channelName(channelId), () => Effect.succeed(channelId))
      names.set(channelId, name)
    }
    const lines = [...activeTasks.values()].map((task) => {
      const channel = (names.get(task.channelId) ?? task.channelId).slice(0, ActivityChannelLimit)
      return `[#${channel}] ${task.label}`
    })
    const description = packApplicationDescription(lines)
    if (description === lastDescription) return
    yield* patchDescription(description)
    lastDescription = description
  })

  const publishDescriptionSafely = Effect.catch(publishDescription, (cause) =>
    Effect.logWarning('discord.application-description.failed').pipe(
      Effect.annotateLogs({ cause: String(cause) }),
    ),
  )

  // Coalesces bursts of task transitions into one PATCH per debounce window.
  const scheduleDescription = Effect.gen(function* () {
    if (scheduled !== null) return
    scheduled = yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* Effect.sleep(options.descriptionDebounce ?? DescriptionDebounce)
        scheduled = null
        yield* publishDescriptionSafely
      }),
    )
  })

  return (input) =>
    Effect.tryPromise({
      try: async () => {
        const location = discord.decodeThreadId(String(input.binding.conversationId))
        if (describeActivity) {
          if (input.active) {
            // Continuations restart a finished task without its prompt text; keep the prior label.
            const existing = activeTasks.get(input.taskId)
            const label =
              input.task !== undefined
                ? sanitizeTaskLabel(input.task) || 'Working...'
                : (existing?.label ?? 'Working...')
            activeTasks.set(input.taskId, { channelId: location.channelId, label })
          } else {
            activeTasks.delete(input.taskId)
          }
        }
        if (!location.guildId) return null
        if (botUserId === null) {
          const response = await fetch(`${discordApiBase}/users/@me`, {
            headers: { Authorization: `Bot ${botToken}` },
          })
          if (!response.ok) {
            throw new Error(`Discord bot user lookup failed: HTTP ${response.status}`)
          }
          // SAFETY: Discord's documented current-user response always includes the user's snowflake ID.
          const user = (await response.json()) as { id: string }
          botUserId = user.id
        }
        let baseName = baseNames.get(location.guildId)
        if (!baseName) {
          const response = await fetch(
            `${discordApiBase}/guilds/${location.guildId}/members/${botUserId}`,
            { headers: { Authorization: `Bot ${botToken}` } },
          )
          if (!response.ok) {
            throw new Error(`Discord bot member lookup failed: HTTP ${response.status}`)
          }
          // SAFETY: Discord's documented guild-member response exposes optional nick and user fields.
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
        const response = await fetch(`${discordApiBase}/guilds/${location.guildId}/members/@me`, {
          method: 'PATCH',
          headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ nick: nickname }),
        })
        if (!response.ok)
          throw new Error(`Discord bot nickname update failed: HTTP ${response.status}`)
        return { guildId: location.guildId, nickname, activeTaskCount: count }
      },
      catch: (cause) => new ChatSdkPublicationError({ operation: 'set-agent-activity', cause }),
    }).pipe(
      Effect.tap((result) =>
        result === null
          ? Effect.void
          : Effect.logInfo('discord.agent-activity.updated').pipe(Effect.annotateLogs(result)),
      ),
      Effect.ensuring(describeActivity ? scheduleDescription : Effect.void),
    )
}
