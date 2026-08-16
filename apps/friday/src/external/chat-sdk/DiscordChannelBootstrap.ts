/* oxlint-disable effecttsgo/node-builtin-import -- Workspace path composition uses the Node path API beside FRIDAY_HOME. */

import {
  ChannelThread,
  ExternalChannelId,
  ExternalMessageId,
  ExternalThreadId,
  ThreadId,
  type ChannelThread as ChannelThreadType,
} from '@friday/contracts/conversation'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { join } from 'node:path'

import { ThreadPersistence } from '../../conversation/ThreadPersistence.ts'
import { FRIDAY_HOME } from '../../FridayHome.ts'

const decodeChannelThread = Schema.decodeUnknownSync(ChannelThread)
const decodeThreadId = Schema.decodeUnknownSync(ThreadId)
const decodeChannelId = Schema.decodeUnknownSync(ExternalChannelId)
const decodeMessageId = Schema.decodeUnknownSync(ExternalMessageId)
const decodeExternalThreadId = Schema.decodeUnknownSync(ExternalThreadId)

export interface DiscordChannelBootstrapOptions {
  guildId: string
  channelId: string
  modelProvider?: string
  modelId?: string
  thinkingLevel?: ChannelThreadType['thinkingLevel']
}

export const ensureDiscordChannelThread = Effect.fn('ensureDiscordChannelThread')(function* (
  options: DiscordChannelBootstrapOptions,
) {
  const persistence = yield* ThreadPersistence
  const crypto = yield* Crypto.Crypto
  const fileSystem = yield* FileSystem.FileSystem
  const channelId = decodeChannelId(options.channelId)
  const workingDirectory = join(FRIDAY_HOME, 'workspaces', `discord-${options.channelId}`)
  yield* fileSystem.makeDirectory(workingDirectory, { recursive: true })
  yield* fileSystem.writeFileString(
    join(workingDirectory, 'AGENTS.md'),
    `# Friday Discord channel\n\n- Guild ID: ${options.guildId}\n- Channel ID: ${options.channelId}\n- This is the long-lived user-facing channel workspace.\n- Reply with only the final response intended for Discord.\n`,
  )
  const existing = yield* persistence.findChannelThread({
    platform: 'discord',
    channelId,
  })
  if (Option.isSome(existing)) return existing.value

  const timestamp = DateTime.formatIso(yield* DateTime.now)
  const thread = decodeChannelThread({
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
    externalBinding: {
      platform: 'discord',
      channelId,
      sourceMessageId: decodeMessageId(`channel:${options.channelId}`),
      externalThreadId: decodeExternalThreadId(`discord:${options.guildId}:${options.channelId}`),
    },
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null,
  })
  yield* persistence.createThread(thread)
  return thread
})
