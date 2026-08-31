import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'

import type { PlatformAgentActivity } from '../PlatformAdapter.ts'
import { ChatSdkPublicationError } from '../chat-sdk/Errors.ts'

const activitySuffix = / ⚡️(?:x\d+)?$/u
const discordApiBase = 'https://discord.com/api/v10'
const descriptionPrefix = 'Friday task activity ['
const DescriptionDebounce: Duration.Input = '2 seconds'
const RetryDelay: Duration.Input = '1 second'
const ConservativeRetryDelayMs = 5_000
const MaximumPatchAttempts = 4

/** Discord's documented application-description character limit. */
export const ApplicationDescriptionLimit = 400
/** Caps for the public, global application description's sanitized labels. */
export const ActivityLabelLimit = 64
export const ActivityChannelLimit = 32

export interface DiscordAgentActivityOptions {
  /**
   * Opt in to a global, public Discord application description containing sanitized
   * channel names and task labels. Disabled by default.
   */
  readonly activityDescription?: boolean | undefined
  readonly installationId?: string | undefined
  readonly descriptionDebounce?: Duration.Input | undefined
  readonly retryDelay?: Duration.Input | undefined
}

interface ActiveTask {
  readonly channelId: string
  readonly label: string
}

class DescriptionPatchError extends Schema.Error<DescriptionPatchError>('DescriptionPatchError')({
  _tag: Schema.tag('DescriptionPatchError'),
  status: Schema.Number,
  transient: Schema.Boolean,
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

const CurrentApplication = Schema.Struct({ id: Schema.String, description: Schema.String })
const RateLimitBody = Schema.Struct({ retry_after: Schema.Number })
const ChannelResponse = Schema.Struct({ name: Schema.NullOr(Schema.String) })
const CurrentUserResponse = Schema.Struct({ id: Schema.String })
const GuildMemberResponse = Schema.Struct({
  nick: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.Struct({ username: Schema.optional(Schema.String) })),
})
const decodeCurrentApplication = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CurrentApplication),
)
const decodeChannelResponse = Schema.decodeEffect(Schema.fromJsonString(ChannelResponse))
const decodeRateLimitBody = Schema.decodeUnknownOption(Schema.fromJsonString(RateLimitBody))
const decodeCurrentUserResponse = Schema.decodeUnknownSync(CurrentUserResponse)
const decodeGuildMemberResponse = Schema.decodeUnknownSync(GuildMemberResponse)

const truncateCodePoints = (value: string, maxLength: number): string =>
  Array.from(value).slice(0, maxLength).join('')

/**
 * Derives a concise single-line public label from delegated task text. It removes
 * code blocks, Discord mentions, timestamps, and Markdown markers before truncation.
 * Ordinary text can remain unchanged, so enabling publication must be an explicit choice.
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
  if (Array.from(label).length <= maxLength) return label
  return `${truncateCodePoints(label, maxLength - 1).trimEnd()}…`
}

const overflowText = (hidden: number): string =>
  hidden === 1 ? '... 1 more task.' : `... ${hidden} more tasks.`

const renderedLength = (lines: ReadonlyArray<string>): number =>
  lines.reduce((total, line) => total + Array.from(line).length + 1, -1)

/** Packs complete activity lines within Discord's code-point limit. */
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

const parseRetryAfterHeader = (value: string | null, now: number): number | undefined => {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

export const retryAfterMilliseconds = (
  header: string | null,
  body: string,
  now: number = Date.now(),
): number => {
  const headerDelay = parseRetryAfterHeader(header, now)
  const decodedBody = decodeRateLimitBody(body)
  const bodyDelay =
    Option.isSome(decodedBody) && decodedBody.value.retry_after >= 0
      ? decodedBody.value.retry_after * 1_000
      : undefined
  const valid = [headerDelay, bodyDelay].filter((delay): delay is number => delay !== undefined)
  return valid.length === 0 ? ConservativeRetryDelayMs : Math.max(...valid)
}

const ownershipMarker = (installationId: string): string =>
  `${descriptionPrefix}${truncateCodePoints(installationId, 64)}]:\n`

export const hasOwnedDescription = (description: string, installationId: string): boolean =>
  description.startsWith(ownershipMarker(installationId))

export const findDuplicateDiscordApplications = (
  connections: ReadonlyArray<{
    readonly connectionId: string
    readonly applicationId: string
    readonly botToken: string
  }>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const identities = new Map<string, Array<string>>()
  for (const connection of connections) {
    const identity = `${connection.applicationId}\u0000${connection.botToken}`
    const existing = identities.get(identity) ?? []
    existing.push(connection.connectionId)
    identities.set(identity, existing)
  }
  return [...identities.values()].filter((connectionIds) => connectionIds.length > 1)
}

export const makeDiscordAgentActivity = (
  discord: Pick<DiscordAdapter, 'decodeThreadId'>,
  botToken: string,
  options: DiscordAgentActivityOptions = {},
): Effect.Effect<
  (input: PlatformAgentActivity) => Effect.Effect<void, ChatSdkPublicationError>,
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const baseNames = new Map<string, string>()
    const activeTaskIds = new Map<string, Set<string>>()
    const channelNames = new Map<string, string>()
    const activeTasks = new Map<string, ActiveTask>()
    const describeActivity = options.activityDescription === true
    const installationId = options.installationId ?? 'unknown-installation'
    const marker = ownershipMarker(installationId)
    const changes = yield* Queue.sliding<void>(1)
    let botUserId: string | null = null
    let lastDescription: string | null = null

    const channelName = Effect.fn('DiscordAgentActivity.channelName')(function* (
      channelId: string,
    ) {
      const cached = channelNames.get(channelId)
      if (cached !== undefined) return cached
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${discordApiBase}/channels/${channelId}`, {
            signal,
            headers: { Authorization: `Bot ${botToken}` },
          }),
        catch: (cause) => new ChatSdkPublicationError({ operation: 'lookup-channel', cause }),
      })
      if (!response.ok) {
        return yield* new ChatSdkPublicationError({
          operation: 'lookup-channel',
          cause: new Error(`Discord channel lookup failed: HTTP ${response.status}`),
        })
      }
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) => new ChatSdkPublicationError({ operation: 'lookup-channel', cause }),
      })
      const channel = yield* decodeChannelResponse(body).pipe(
        Effect.mapError(
          (cause) => new ChatSdkPublicationError({ operation: 'lookup-channel', cause }),
        ),
      )
      const name = channel.name ?? channelId
      channelNames.set(channelId, name)
      return name
    })

    const currentApplication = Effect.fn('DiscordAgentActivity.currentApplication')(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${discordApiBase}/applications/@me`, {
            signal,
            headers: { Authorization: `Bot ${botToken}` },
          }),
        catch: (cause) =>
          new ChatSdkPublicationError({ operation: 'set-application-description', cause }),
      })
      if (!response.ok) {
        return yield* new ChatSdkPublicationError({
          operation: 'set-application-description',
          cause: new Error(`Discord application lookup failed: HTTP ${response.status}`),
        })
      }
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (cause) =>
          new ChatSdkPublicationError({ operation: 'set-application-description', cause }),
      })
      return yield* decodeCurrentApplication(body).pipe(
        Effect.mapError(
          (cause) =>
            new ChatSdkPublicationError({ operation: 'set-application-description', cause }),
        ),
      )
    })

    const patchDescription = Effect.fn('DiscordAgentActivity.patchDescription')(function* (
      description: string,
    ) {
      if (description.length > 0) {
        const current = yield* currentApplication().pipe(
          Effect.mapError(() => new DescriptionPatchError({ status: 0, transient: true })),
        )
        if (
          current.description.length > 0 &&
          !hasOwnedDescription(current.description, installationId)
        ) {
          return yield* new DescriptionPatchError({ status: 409, transient: false })
        }
      }
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${discordApiBase}/applications/@me`, {
            signal,
            method: 'PATCH',
            headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ description }),
          }),
        catch: () => new DescriptionPatchError({ status: 0, transient: true }),
      })
      if (response.ok) return
      const body =
        response.status === 429
          ? yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () => new DescriptionPatchError({ status: 429, transient: true }),
            }).pipe(Effect.orElseSucceed(() => ''))
          : ''
      return yield* new DescriptionPatchError({
        status: response.status,
        transient: response.status === 429 || response.status >= 500,
        retryAfterMs:
          response.status === 429
            ? retryAfterMilliseconds(response.headers.get('Retry-After'), body)
            : undefined,
      })
    })

    const desiredDescription = Effect.fn('DiscordAgentActivity.desiredDescription')(function* () {
      const names = new Map<string, string>()
      for (const channelId of new Set([...activeTasks.values()].map((task) => task.channelId))) {
        const name = yield* Effect.catch(channelName(channelId), () => Effect.succeed(channelId))
        names.set(channelId, name)
      }
      const lines = [...activeTasks.values()].map((task) => {
        const channel = truncateCodePoints(
          names.get(task.channelId) ?? task.channelId,
          ActivityChannelLimit,
        )
        return `[#${channel}] ${task.label}`
      })
      const available = ApplicationDescriptionLimit - Array.from(marker).length
      const activity = packApplicationDescription(lines, available)
      return activity.length === 0 ? '' : `${marker}${activity}`
    })

    const publishLatest = Effect.fn('DiscordAgentActivity.publishLatest')(function* () {
      let attempt = 0
      while (attempt < MaximumPatchAttempts) {
        const desired = yield* desiredDescription()
        if (desired === lastDescription) return true
        const result = yield* patchDescription(desired).pipe(
          Effect.matchEffect({
            onFailure: (error) => Effect.succeed({ success: false as const, error }),
            onSuccess: () => Effect.succeed({ success: true as const }),
          }),
        )
        if (result.success) {
          lastDescription = desired
          return true
        }
        attempt += 1
        if (!result.error.transient || attempt >= MaximumPatchAttempts) {
          yield* Effect.logWarning('discord.application-description.failed').pipe(
            Effect.annotateLogs({ status: result.error.status, attempt }),
          )
          return false
        }
        yield* Effect.sleep(
          result.error.retryAfterMs === undefined
            ? (options.retryDelay ?? RetryDelay)
            : Duration.millis(result.error.retryAfterMs),
        )
      }
      return false
    })

    const cleanupOwnedDescription = Effect.fn('DiscordAgentActivity.cleanupOwnedDescription')(
      function* () {
        const application = yield* currentApplication()
        if (!hasOwnedDescription(application.description, installationId)) {
          lastDescription = application.description
          return
        }
        yield* patchDescription('').pipe(
          Effect.mapError(
            (cause) =>
              new ChatSdkPublicationError({ operation: 'set-application-description', cause }),
          ),
        )
        lastDescription = ''
      },
    )

    yield* cleanupOwnedDescription().pipe(
      Effect.catch((cause) =>
        Effect.logWarning('discord.application-description.cleanup-failed').pipe(
          Effect.annotateLogs({ cause: String(cause) }),
        ),
      ),
    )

    if (describeActivity) {
      const awaitTrailingEdge = Effect.fn('DiscordAgentActivity.awaitTrailingEdge')(function* () {
        while (true) {
          const next = yield* Queue.take(changes).pipe(
            Effect.timeoutOption(options.descriptionDebounce ?? DescriptionDebounce),
          )
          if (Option.isNone(next)) return
        }
      })
      yield* Effect.gen(function* () {
        while (true) {
          yield* Queue.take(changes)
          yield* awaitTrailingEdge()
          yield* publishLatest()
        }
      }).pipe(Effect.forkScoped)
    }

    return (input: PlatformAgentActivity): Effect.Effect<void, ChatSdkPublicationError> =>
      Effect.tryPromise({
        try: async () => {
          const location = discord.decodeThreadId(String(input.binding.conversationId))
          if (describeActivity) {
            if (input.active) {
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
            if (!response.ok)
              throw new Error(`Discord bot user lookup failed: HTTP ${response.status}`)
            const user = decodeCurrentUserResponse(await response.json())
            botUserId = user.id
          }
          let baseName = baseNames.get(location.guildId)
          if (!baseName) {
            const response = await fetch(
              `${discordApiBase}/guilds/${location.guildId}/members/${botUserId}`,
              { headers: { Authorization: `Bot ${botToken}` } },
            )
            if (!response.ok)
              throw new Error(`Discord bot member lookup failed: HTTP ${response.status}`)
            const member = decodeGuildMemberResponse(await response.json())
            baseName = (member.nick ?? member.user?.username ?? 'Friday').replace(
              activitySuffix,
              '',
            )
            baseNames.set(location.guildId, baseName)
          }
          const tasks = activeTaskIds.get(location.guildId) ?? new Set<string>()
          if (input.active) tasks.add(input.taskId)
          else tasks.delete(input.taskId)
          activeTaskIds.set(location.guildId, tasks)
          const count = tasks.size
          const suffix = count === 0 ? '' : count === 1 ? ' ⚡️' : ` ⚡️x${count}`
          const nickname = truncateCodePoints(`${baseName}${suffix}`, 32)
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
        Effect.ensuring(describeActivity ? Queue.offer(changes, undefined) : Effect.void),
      )
  })
