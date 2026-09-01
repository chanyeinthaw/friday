/* oxlint-disable effecttsgo/node-builtin-import, eslint/no-underscore-dangle -- Workspace paths use Node path; Effect schema errors use the canonical _tag discriminator. */

import { ChannelThread, ThreadId } from '@friday/contracts/conversation'
import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { join } from 'node:path'

import { FRIDAY_HOME } from '../../FridayHome.ts'
import type { AppConfig } from '../../config/AppConfig.ts'
import type { PlatformInput } from '../PlatformAdapter.ts'

const ChannelMetadata = Schema.Struct({
  topic: Schema.optional(Schema.NullOr(Schema.String)),
})
const decodeChannelMetadata = Schema.decodeUnknownOption(ChannelMetadata)
const decodeChannelThread = Schema.decodeUnknownSync(ChannelThread)
const decodeThreadId = Schema.decodeUnknownSync(ThreadId)

export class DiscordThreadBootstrapError extends Schema.Error<DiscordThreadBootstrapError>(
  'DiscordThreadBootstrapError',
)({
  _tag: Schema.tag('DiscordThreadBootstrapError'),
  operation: Schema.Literals(['channel-context', 'workspace']),
  cause: Schema.Defect(),
}) {}

export interface DiscordThreadBootstrapOptions {
  discord: DiscordAdapter
  workingDirectoryRoot?: string
  /**
   * Reads the current primary model at thread-creation time so configuration
   * reloads apply to newly bootstrapped threads without a restart.
   */
  model?: () => AppConfig['models']['primary']
}

export const makeDiscordThreadBootstrap = Effect.fn('makeDiscordThreadBootstrap')(function* (
  options: DiscordThreadBootstrapOptions,
) {
  const crypto = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem

  return Effect.fn('DiscordThreadBootstrap.create')(function* (inbound: PlatformInput) {
    const channel = yield* Effect.tryPromise({
      try: () => options.discord.fetchChannelInfo(String(inbound.binding.channelId)),
      catch: (cause) => new DiscordThreadBootstrapError({ operation: 'channel-context', cause }),
    })
    const metadata = Option.getOrNull(decodeChannelMetadata(channel.metadata.raw))
    const channelName = channel.name ?? String(inbound.binding.channelId)
    const channelDescription = metadata?.topic ?? ''
    const workspaceName = String(inbound.binding.conversationId).replaceAll(':', '-')
    const workingDirectory = join(
      options.workingDirectoryRoot ?? join(FRIDAY_HOME, 'workspaces'),
      workspaceName,
    )
    yield* fileSystem
      .makeDirectory(workingDirectory, { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new DiscordThreadBootstrapError({ operation: 'workspace', cause }),
        ),
      )
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    // One coherent read: a reload between two reads could otherwise pair a
    // model from one snapshot with a thinking level from another.
    const model = options.model?.()
    return decodeChannelThread({
      id: decodeThreadId(yield* crypto.randomUUIDv4),
      audience: 'user',
      parent: null,
      harness: 'pi',
      harnessSession: null,
      workingDirectory,
      model: model ?? {
        provider: 'opencode-go',
        modelId: 'deepseek-v4-flash',
      },
      thinkingLevel: model?.thinkingLevel ?? 'max',
      channelContext: {
        name: channelName,
        description: channelDescription,
      },
      conversationBinding: inbound.binding,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    })
  })
})
