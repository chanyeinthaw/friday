import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Regression guard: a refactor once registered the raw chat SDK platform and
// silently dropped the activity-title wrapper. The platform handed to
// PlatformRegistry must be the withDiscordThreadActivityTitle-wrapped one.
const liveSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'DiscordLive.ts'),
  'utf8',
)

describe('DiscordLive wiring', () => {
  it('registers the platform wrapped with the thread activity title', () => {
    const wrapMatch = /withDiscordThreadActivityTitle\(discord,\s*chatSdkPlatform\)/u.exec(
      liveSource,
    )
    expect(wrapMatch).not.toBeNull()
    const registerIndex = liveSource.indexOf('platforms.register(platform)')
    expect(registerIndex).toBeGreaterThan(wrapMatch?.index ?? -1)
  })

  it('completes slash responses through the channel, never postEphemeral', () => {
    // The Discord adapter (chat SDK 4.38) implements no postEphemeral, so a
    // postEphemeral call returns null and leaves the deferred interaction
    // response hanging forever. The reply must go through event.channel.post,
    // which the adapter intercepts to complete the interaction webhook.
    expect(liveSource).toContain('event.channel.post(message)')
    expect(liveSource).not.toMatch(/\.postEphemeral\(/u)
  })

  it('wires /harness reload onto the pool with persistence thread lookup', () => {
    // The handler must be registered for the adapter-produced /harness paths,
    // resolve the thread bound to the invoking conversation, and reload the
    // existing runtime through the pool (never opening an absent runtime).
    expect(liveSource).toContain('chat.onSlashCommand(HARNESS_COMMAND_PATHS')
    expect(liveSource).toContain('reloadConversationHarness({')
    expect(liveSource).toContain('findThread: persistence.findPlatformThread')
    expect(liveSource).toContain('reloadRuntime: pool.reloadHarness')
  })

  it('keeps harness reload replies ephemeral and registers both global commands', () => {
    const flagsIndex = liveSource.indexOf('DiscordInteractionResponseFlag.Ephemeral')
    expect(flagsIndex).toBeGreaterThan(-1)
    // Both command path families share the ephemeral interaction flag.
    expect(liveSource).toMatch(/\[\.\.\.FRIDAY_COMMAND_PATHS, \.\.\.HARNESS_COMMAND_PATHS\]/u)
    expect(liveSource).toContain('harnessReloadReply(outcome)')
    expect(liveSource).toContain('yield* registerGlobalDiscordCommands({')
  })
})
