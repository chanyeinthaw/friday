/* oxlint-disable effecttsgo/node-builtin-import, eslint/no-underscore-dangle -- Workspace paths use Node path; Effect schema errors use the canonical _tag discriminator. */

import {
  ChannelThread,
  ThreadId,
  type ChannelThread as ChannelThreadType,
} from '@friday/contracts/conversation'
import type { DiscordAdapter } from '@chat-adapter/discord'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { join } from 'node:path'

import { FRIDAY_HOME } from '../../FridayHome.ts'
import type { SurfaceInput } from '../Surface.ts'

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
  recentMessageCount?: number
  modelProvider?: string
  modelId?: string
  thinkingLevel?: ChannelThreadType['thinkingLevel']
}

const renderWorkspaceInstructions = (context: {
  readonly channelName: string
  readonly channelDescription: string
  readonly channelId: string
  readonly discordThreadId: string
  readonly initiatingMessage: string
  readonly recentMessages: ReadonlyArray<{
    readonly author: string
    readonly text: string
  }>
}): string => `# Friday Discord conversation

## Discord source

- Channel: ${context.channelName}
- Channel ID: ${context.channelId}
- Discord thread: ${context.discordThreadId}

## Channel description

${context.channelDescription || '(No channel description)'}

## Recent parent-channel messages

${
  context.recentMessages.length === 0
    ? '(No earlier messages)'
    : context.recentMessages.map(({ author, text }) => `- ${author}: ${text}`).join('\n')
}

## Initiating message

${context.initiatingMessage}

## Instructions

- This workspace belongs only to this Discord thread.
- Continue the same Pi session for follow-up messages in this Discord thread.
- Do not mix context from other Discord threads.
- Return only the final response intended for Discord.
`

export const makeDiscordThreadBootstrap = Effect.fn('makeDiscordThreadBootstrap')(function* (
  options: DiscordThreadBootstrapOptions,
) {
  const crypto = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem

  return Effect.fn('DiscordThreadBootstrap.create')(function* (inbound: SurfaceInput) {
    const channelContext = yield* Effect.tryPromise({
      try: async () => {
        const [channel, recent] = await Promise.all([
          options.discord.fetchChannelInfo(String(inbound.binding.channelId)),
          options.discord.fetchChannelMessages(String(inbound.binding.channelId), {
            limit: options.recentMessageCount ?? 20,
            direction: 'backward',
          }),
        ])
        return { channel, recent }
      },
      catch: (cause) => new DiscordThreadBootstrapError({ operation: 'channel-context', cause }),
    })
    const metadata = Option.getOrNull(decodeChannelMetadata(channelContext.channel.metadata.raw))
    const recentMessages = channelContext.recent.messages
      .filter(({ id }) => id !== inbound.message.surfaceMessageId)
      .map((message) => ({
        author: message.author.fullName || message.author.userName,
        text: message.text,
      }))
    const workspaceName = String(inbound.binding.conversationId).replaceAll(':', '-')
    const workingDirectory = join(FRIDAY_HOME, 'workspaces', workspaceName)
    yield* fileSystem.makeDirectory(workingDirectory, { recursive: true }).pipe(
      Effect.andThen(
        fileSystem.writeFileString(
          join(workingDirectory, 'AGENTS.md'),
          renderWorkspaceInstructions({
            channelName: channelContext.channel.name ?? String(inbound.binding.channelId),
            channelDescription: metadata?.topic ?? '',
            channelId: String(inbound.binding.channelId),
            discordThreadId: String(inbound.binding.conversationId),
            initiatingMessage: inbound.message.content.text,
            recentMessages,
          }),
        ),
      ),
      Effect.mapError(
        (cause) => new DiscordThreadBootstrapError({ operation: 'workspace', cause }),
      ),
    )
    const timestamp = DateTime.formatIso(yield* DateTime.now)
    return decodeChannelThread({
      id: decodeThreadId(yield* crypto.randomUUIDv4),
      audience: 'user',
      parent: null,
      harness: 'pi',
      harnessSession: null,
      workingDirectory,
      model: {
        provider: options.modelProvider ?? 'opencode-go',
        modelId: options.modelId ?? 'deepseek-v4-flash',
      },
      thinkingLevel: options.thinkingLevel ?? 'max',
      surfaceBinding: inbound.binding,
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
    })
  })
})
