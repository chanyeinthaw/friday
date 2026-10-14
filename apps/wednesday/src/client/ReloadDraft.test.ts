import { afterEach, expect, test, vi } from 'vitest'
import { Effect } from 'effect'
import { it } from '@effect/vitest'
import {
  canReload,
  canRestoreDraft,
  saveReloadDraft,
  takeReloadDraft,
  type ReloadDraft,
} from './ReloadDraft.ts'
import { initialModel, update } from './App.ts'
import { Message } from './Messages.ts'

const draft: ReloadDraft = {
  userId: 'user_a',
  revision: 3,
  savedAt: Date.now(),
  draft: 'Unsent message',
  attachments: [{ id: 'file_a', name: 'notes.md', mediaType: 'text/markdown', size: 12 }],
  reply: { id: 42, kind: 'talk', text: 'Reply to this' },
}
afterEach(() => vi.unstubAllGlobals())

it.effect(
  'reload drafts round-trip with attachments and replies, isolated by user and consumed once',
  () =>
    Effect.gen(function* () {
      const storage = new Map<string, string>()
      vi.stubGlobal('sessionStorage', {
        setItem: (key: string, value: string) => storage.set(key, value),
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      })
      yield* saveReloadDraft(draft)
      expect(yield* takeReloadDraft('user_b')).toBeNull()
      expect(yield* takeReloadDraft('user_a')).toEqual(draft)
      expect(yield* takeReloadDraft('user_a')).toBeNull()
    }),
)

test('draft restoration rejects changed conversations, users, and expired drafts', () => {
  expect(canRestoreDraft(draft, 'user_a', 3, draft.savedAt + 1000)).toBe(true)
  expect(canRestoreDraft(draft, 'user_b', 3, draft.savedAt)).toBe(false)
  expect(canRestoreDraft(draft, 'user_a', 4, draft.savedAt)).toBe(false)
  expect(canRestoreDraft(draft, 'user_a', 3, draft.savedAt + 86_400_000)).toBe(false)
  const model = { ...initialModel, userId: 'user_a', conversationRevision: 3 }
  const restored = update(model, Message.RestoredDraft({ draft })).model
  expect(restored.draft).toBe(draft.draft)
  expect(restored.attachments).toEqual(draft.attachments)
  expect(restored.reply).toEqual(draft.reply)
  expect(
    update({ ...model, draft: 'New typing' }, Message.RestoredDraft({ draft })).model.draft,
  ).toBe('New typing')
})

test('reload waits for synchronization, active responses, uploads, settings saves, and pending sends', () => {
  const model = { ...initialModel, connection: 'ready' as const }
  expect(canReload(model)).toBe(true)
  expect(canReload({ ...model, busy: true })).toBe(false)
  expect(canReload({ ...model, uploading: 1 })).toBe(false)
  expect(canReload({ ...model, saving: true })).toBe(false)
  expect(canReload({ ...model, connection: 'syncing' })).toBe(false)
  expect(
    canReload({
      ...model,
      pendingMessages: [
        { requestId: 'r', text: 'Sending', mode: 'send', date: 'now', status: 'sending' },
      ],
    }),
  ).toBe(false)
})
