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
})
