import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const liveSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'SlackLive.ts'),
  'utf8',
)

describe('SlackLive wiring', () => {
  it('delegates admission to the shared layer instead of a second invocation implementation', () => {
    // The authoritative admission/invocation flow lives in PlatformAdmission:
    // policy resolve, user admission, duplicate check, binding lookup,
    // invocation decision, and admit/drop logging. The lifecycle path must
    // call it with Slack semantics (canonical policy resolve, user check,
    // socket-redelivery dedup, DM/mention/continuation decision).
    expect(liveSource).toContain('admitPlatformMessage(')
    expect(liveSource).toContain("platform: 'slack'")
    expect(liveSource).toContain('resolvePolicy:')
    expect(liveSource).toContain('isUserAdmitted:')
    expect(liveSource).toContain('checkDuplicate:')
    expect(liveSource).toContain('shouldInvokeSlack({')
    // Unmentioned chatter in unsubscribed threads never reaches the three
    // Chat handlers (Chat drops it after routing), so all-messages delivery
    // needs the shared lifecycle catch-all; invocation itself still belongs
    // to the admission hooks above.
    expect(liveSource).toContain('catchAll:')
    expect(liveSource).toContain("kind: 'subscribed-message'")
    // The old duplicated orchestration must not return: per-platform
    // allowed/ignored/duplicate logging and a full shouldHandleMessage gate
    // would be a second invocation implementation alongside the shared layer.
    // The narrow adapter preflight in FridaySlackAdapter remains the only
    // early gate, and it owns admission only (never invocation).
    expect(liveSource).not.toContain('slack.message.allowed')
    expect(liveSource).not.toContain('slack.message.ignored')
    expect(liveSource).not.toContain('slack.message.duplicate')
    expect(liveSource).not.toContain('shouldHandleMessage:')
  })
})
