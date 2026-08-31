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
})
