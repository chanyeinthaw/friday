import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { PlatformInput } from '../PlatformAdapter.ts'
import { isDiscordThread } from './DiscordConversationScope.ts'

const DiscordThreadOwnerRaw = Schema.Struct({
  owner_id: Schema.optional(Schema.String),
})
const decodeOwnerRaw = Schema.decodeUnknownOption(DiscordThreadOwnerRaw)

export interface DiscordThreadOwnershipAdapter extends Pick<
  DiscordAdapter,
  'decodeThreadId' | 'fetchChannelInfo'
> {}

// Ownership signal for automatic Discord thread naming: a thread counts as
// Friday-created only when Discord reports its owner as Friday's application.
// Threads owned by anyone else existed before Friday began handling the
// conversation and must keep their current name.
export const shouldTitleDiscordThread = Effect.fn('DiscordThreadOwnership.shouldTitle')(function* (
  discord: DiscordThreadOwnershipAdapter,
  applicationId: string,
  input: PlatformInput,
) {
  if (input.binding.platform !== 'discord') return true
  const conversationId = String(input.binding.conversationId)
  const location = yield* Effect.try({
    try: () => discord.decodeThreadId(conversationId),
    catch: () => 'decode-failed' as const,
  }).pipe(Effect.orElseSucceed(() => null))
  if (location === null) return false
  if (!isDiscordThread(location)) return false
  const info = yield* Effect.tryPromise({
    try: () => discord.fetchChannelInfo(conversationId),
    catch: () => 'fetch-failed' as const,
  }).pipe(Effect.orElseSucceed(() => null))
  if (info === null) return false
  const owner = decodeOwnerRaw(info.metadata.raw)
  if (Option.isNone(owner)) return false
  const ownerId = owner.value.owner_id
  if (ownerId === undefined) return false
  return ownerId === applicationId
})
