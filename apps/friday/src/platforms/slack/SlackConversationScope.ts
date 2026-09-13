export interface SlackConversationLocation {
  readonly teamId: string
  readonly channelId: string
  readonly threadTs?: string | undefined
}

/** True when the location addresses a Slack thread rather than a channel root. */
export const isSlackThread = (location: SlackConversationLocation): boolean =>
  location.threadTs !== undefined && location.threadTs.trim().length > 0

/** Channel-level binding address for a Slack channel. */
export const slackChannelId = (
  location: Pick<SlackConversationLocation, 'teamId' | 'channelId'>,
): string => `slack:${location.teamId}:${location.channelId}`

/** Conversation binding address; thread replies append the root thread timestamp. */
export const slackConversationId = (location: SlackConversationLocation): string =>
  isSlackThread(location)
    ? `slack:${location.teamId}:${location.channelId}:${location.threadTs}`
    : slackChannelId(location)

/** Channel conversation id for a location, dropping any thread timestamp. */
export const slackChannelConversationId = (
  location: Pick<SlackConversationLocation, 'teamId' | 'channelId'>,
): string => slackChannelId(location)

/** Canonical conversation id: channel roots stay channel-scoped, threads keep their timestamp. */
export const slackCanonicalConversationId = (conversationId: string): string => {
  const location = decodeSlackConversationId(conversationId)
  return location === undefined ? conversationId : slackConversationId(location)
}

/**
 * Decodes a Slack conversation id of the form `slack:{team}:{channel}` or
 * `slack:{team}:{channel}:{threadTs}`. Returns undefined for foreign bindings.
 */
export const decodeSlackConversationId = (
  conversationId: string,
): SlackConversationLocation | undefined => {
  const parts = conversationId.split(':')
  if (parts[0] !== 'slack' || parts.length < 3 || parts.length > 4) return undefined
  const [, teamId, channelId, threadTs] = parts
  if (teamId === undefined || teamId === '' || channelId === undefined || channelId === '') {
    return undefined
  }
  if (threadTs !== undefined && threadTs === '') return undefined
  return threadTs === undefined ? { teamId, channelId } : { teamId, channelId, threadTs }
}

/**
 * Decodes a Slack adapter thread id of the form `slack:{channel}` or
 * `slack:{channel}:{threadTs}`. The adapter omits the workspace team: it is
 * the transport identity, never the persistence identity. Returns undefined
 * for foreign or malformed ids, including canonical Friday ids
 * (`slack:{team}:{channel}`) whose second segment is a team, not a channel.
 * An empty thread timestamp means channel scope.
 */
export const decodeSlackAdapterThreadId = (
  threadId: string,
): { readonly channelId: string; readonly threadTs?: string | undefined } | undefined => {
  const parts = threadId.split(':')
  if (parts[0] !== 'slack' || parts.length < 2 || parts.length > 3) return undefined
  const [, channelId, threadTs] = parts
  if (channelId === undefined || channelId === '') return undefined
  // Adapter channels are Slack channel ids (`C...`, `D...`, `G...`); a `T...`
  // team in this position means a canonical Friday id, never transport.
  if (!/^[CDG]/.test(channelId)) return undefined
  if (threadTs === undefined || threadTs === '') return { channelId }
  return { channelId, threadTs }
}

/**
 * Encodes a canonical Friday location as the Slack adapter thread id
 * (`slack:{channel}:{threadTs}`, empty timestamp for channel roots). The team
 * stays in Friday persistence only; the adapter never observes it.
 */
export const toSlackAdapterThreadId = (location: SlackConversationLocation): string =>
  location.threadTs === undefined || location.threadTs.trim().length === 0
    ? `slack:${location.channelId}:`
    : `slack:${location.channelId}:${location.threadTs}`

/** Adapter channel id (`slack:{channel}`) for a canonical location. */
export const toSlackAdapterChannelId = (
  location: Pick<SlackConversationLocation, 'channelId'>,
): string => `slack:${location.channelId}`

/**
 * Reconciles an inbound Slack event to Friday's canonical scope explicitly.
 * Top-level messages (no `threadTs`) collapse the adapter's per-message thread
 * (`slack:{channel}:{ts}`) to the shared channel root (`slack:{team}:{channel}`),
 * preserving `reply-in-channel` (platform channel = agent thread). Threaded
 * messages keep their root timestamp (`slack:{team}:{channel}:{threadTs}`),
 * preserving `reply-in-thread` (platform thread = agent thread) and routed
 * threads, DMs, and bound-thread continuation. Never adopts the adapter's
 * team-less identity for persistence.
 */
export const reconcileSlackLocation = (input: {
  readonly teamId: string
  readonly channelId: string
  readonly threadTs?: string | undefined
}): SlackConversationLocation =>
  input.threadTs === undefined || input.threadTs.trim().length === 0
    ? { teamId: input.teamId, channelId: input.channelId }
    : { teamId: input.teamId, channelId: input.channelId, threadTs: input.threadTs }
