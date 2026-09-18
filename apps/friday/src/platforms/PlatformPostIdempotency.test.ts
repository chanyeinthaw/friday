import { assert, it } from '@effect/vitest'

import { PlatformPostIdempotency, scopeIdempotencyKey } from './PlatformPostIdempotency.ts'
import { postPayloadFingerprint } from './PiPostPlatformTool.ts'

it('returns the prior result for the same key and payload', async () => {
  const guard = new PlatformPostIdempotency()
  let posts = 0
  const post = async () => {
    posts += 1
    return { posted: true as const }
  }

  const first = await guard.run('key-1', 'payload-a', post)
  const second = await guard.run('key-1', 'payload-a', post)

  assert.deepStrictEqual(second, first)
  assert.strictEqual(posts, 1)
})

it('rejects a spent key with a different payload', async () => {
  const guard = new PlatformPostIdempotency()
  await guard.run('key-1', 'payload-a', async () => 'first')

  let error: unknown
  try {
    await guard.run('key-1', 'payload-b', async () => 'second')
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /different post payload/)
})

it('joins concurrent callers on one in-flight post', async () => {
  const guard = new PlatformPostIdempotency()
  let posts = 0
  const post = async () => {
    posts += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return posts
  }

  const [first, second] = await Promise.all([
    guard.run('key-1', 'payload-a', post),
    guard.run('key-1', 'payload-a', post),
  ])

  assert.strictEqual(first, 1)
  assert.strictEqual(second, 1)
  assert.strictEqual(posts, 1)
})

it('rejects concurrent callers whose payloads disagree', async () => {
  const guard = new PlatformPostIdempotency()
  const post = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    return 'posted'
  }

  const [first, second] = await Promise.allSettled([
    guard.run('key-1', 'payload-a', post),
    guard.run('key-1', 'payload-b', post),
  ])

  assert.strictEqual(first.status, 'fulfilled')
  assert.strictEqual(second.status, 'rejected')
  if (second.status === 'rejected') {
    assert.match(String(second.reason), /different post payload/)
  }
})

it('does not cache failures, so the same key can retry after recovery', async () => {
  const guard = new PlatformPostIdempotency()
  let attempts = 0
  const flaky = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('transport down')
    return 'recovered'
  }

  let error: unknown
  try {
    await guard.run('key-1', 'payload-a', flaky)
  } catch (cause) {
    error = cause
  }
  assert.match(String(error), /transport down/)
  assert.strictEqual(await guard.run('key-1', 'payload-a', flaky), 'recovered')
  assert.strictEqual(attempts, 2)
})

it('evicts the oldest keys once the bound is reached', async () => {
  const guard = new PlatformPostIdempotency(2)
  let posts = 0
  const post = async () => {
    posts += 1
    return posts
  }

  await guard.run('key-1', 'payload-a', post)
  await guard.run('key-2', 'payload-a', post)
  await guard.run('key-3', 'payload-a', post)
  await guard.run('key-2', 'payload-a', post)
  await guard.run('key-1', 'payload-a', post)

  assert.strictEqual(posts, 4)
})

it('fingerprints posts by content rather than key order', () => {
  assert.strictEqual(
    postPayloadFingerprint({ platform: 'discord', threadId: 't', guildId: 'g' }, 'hi'),
    postPayloadFingerprint({ guildId: 'g', platform: 'discord', threadId: 't' }, 'hi'),
  )
  assert.notStrictEqual(
    postPayloadFingerprint({ platform: 'discord', guildId: 'g', channelId: 'c' }, 'a'),
    postPayloadFingerprint({ platform: 'discord', guildId: 'g', channelId: 'c' }, 'b'),
  )
})

it('scopes keys to the connection without ambiguity', () => {
  assert.notStrictEqual(scopeIdempotencyKey('a', 'b:c'), scopeIdempotencyKey('a:b', 'c'))
  assert.strictEqual(
    scopeIdempotencyKey('discord', 'key-1'),
    scopeIdempotencyKey('discord', 'key-1'),
  )
})
