import type { ChatMessage } from '../shared/protocol.ts'
import { describe, expect } from 'vitest'
import { it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import { Browser } from './Browser.ts'
import type { ClientCommand } from '../shared/protocol.ts'
import { initialModel, update, type Model } from './App.ts'
import { Message } from './Messages.ts'
import type { Settings, ModelMapping } from '../shared/protocol.ts'

const modelMapping = {
  id: 'model',
  contextWindow: 128000,
  maxOutputTokens: 8192,
  requestFields: {},
  thinking: { off: {} },
} satisfies ModelMapping
const settings = {
  baseUrl: 'https://example.test/v1',
  modelId: 'model',
  thinking: 'off',
  models: [modelMapping],
} satisfies Settings
const receive = (model: Model, event: Parameters<typeof Message.Received>[0]['event']) =>
  update(model, Message.Received({ event })).model

describe('conversation reconciliation', () => {
  it('preserves older pages on reconnect and deduplicates a repeated history reply', () => {
    const message = (id: number) => ({
      id,
      kind: 'talk' as const,
      text: `Reply ${id}`,
      date: '2026-10-13',
    })
    const page = { _tag: 'History' as const, messages: [message(0), message(1)], hasOlder: false }
    const loaded = receive(
      { ...initialModel, messages: [message(2)], hasOlder: true, loadingHistory: true },
      page,
    )
    expect(loaded.messages.map((item) => item.id)).toEqual([0, 1, 2])
    expect(loaded.loadingHistory).toBe(false)
    const resumed = receive(loaded, {
      _tag: 'Snapshot',
      settings,
      hasApiKey: true,
      busy: false,
      turnId: null,
      messages: [message(3)],
    })
    expect(resumed.messages.map((item) => item.id)).toEqual([0, 1, 2, 3])
    expect(resumed.hasOlder).toBe(false)
    expect(receive(resumed, page).messages).toBe(resumed.messages)
  })
  it('restores streamed paragraphs and clears them atomically when the durable response arrives', () => {
    const streaming = { id: 'turn-0', turnId: 'turn', text: 'First paragraph.', date: '2026-10-13' }
    const restored = receive(initialModel, {
      _tag: 'Snapshot',
      settings,
      hasApiKey: true,
      busy: true,
      turnId: 'turn',
      messages: [],
      streaming,
    })
    expect(restored.streaming).toEqual(streaming)
    const completed = receive(restored, {
      _tag: 'Message',
      completesStreaming: true,
      message: { id: 1, kind: 'talk', text: 'First paragraph.\n\nSecond.', date: '2026-10-13' },
    })
    expect(completed.streaming).toBeNull()
    expect(completed.messages).toHaveLength(1)
    expect(
      receive(restored, { _tag: 'Status', busy: false, turnId: null, pending: [] }).streaming,
    ).toBeNull()
  })
  it('reconciles another tab’s pending steering with durable history', () => {
    const pending = receive(initialModel, {
      _tag: 'Status',
      busy: true,
      turnId: 'turn',
      pending: [
        {
          requestId: 'steer-1',
          text: 'Focus on costs',
          mode: 'steer',
          status: 'waiting',
          turnId: 'turn',
        },
      ],
    })
    expect(pending.pendingMessages).toHaveLength(1)
    const event = {
      _tag: 'Message' as const,
      message: {
        id: 1,
        kind: 'user' as const,
        requestId: 'steer-1',
        text: 'Focus on costs',
        date: '2026-10-12',
      },
    }
    const next = receive(pending, event)
    expect(next.pendingMessages).toHaveLength(0)
    expect(receive(next, event).messages).toBe(next.messages)
  })
  it('merges missed responses while preserving existing rows, draft, and model editor', () => {
    const first = { id: 0, kind: 'user' as const, text: 'Hello', date: '2026-10-12' }
    const state = {
      ...initialModel,
      activeSettings: settings,
      messages: [first],
      draft: 'My next thought',
      editingId: 'unsaved-name',
      settingsDirty: true,
    }
    const next = receive(state, {
      _tag: 'Snapshot',
      settings,
      hasApiKey: true,
      busy: false,
      turnId: null,
      messages: [{ id: 1, kind: 'talk', text: 'Hi', date: '2026-10-12' }],
    })
    expect(next.messages).toHaveLength(2)
    expect(next.messages[0]).toBe(first)
    expect(next.draft).toBe('My next thought')
    expect(next.editingId).toBe('unsaved-name')
    expect(
      receive(next, {
        _tag: 'Snapshot',
        settings,
        hasApiKey: true,
        busy: false,
        turnId: null,
        messages: [],
      }).messages,
    ).toBe(next.messages)
  })
  it('discards unconsumed steering on reconnect and requires an explicit new send', () => {
    const state = {
      ...initialModel,
      pendingMessages: [
        {
          requestId: 'old',
          text: 'Correction',
          mode: 'steer' as const,
          status: 'waiting' as const,
          turnId: 'old-turn',
        },
      ],
    }
    const next = receive(state, {
      _tag: 'Snapshot',
      settings,
      hasApiKey: true,
      messages: [],
      busy: false,
      turnId: null,
      pending: [],
    })
    expect(next.pendingMessages[0]?.status).toBe('discarded')
    const edit = update(next, Message.RetriedSubmission({ requestId: 'old' }))
    expect(edit.model.draft).toBe('Correction')
    expect(edit.commands).toBeUndefined()
    expect(edit.model.pendingMessages).toEqual([])
  })
  it('syncs saved settings without overwriting unsaved provider fields', () => {
    const state = { ...initialModel, baseUrl: 'https://draft.test/v1', settingsDirty: true }
    const next = receive(state, { _tag: 'SettingsChanged', settings })
    expect(next.activeSettings).toBe(settings)
    expect(next.baseUrl).toBe('https://draft.test/v1')
    expect(update(next, Message.ResetSettings()).model.baseUrl).toBe(settings.baseUrl)
  })
  it('preserves history and draft while reconnecting and waits for the snapshot', () => {
    const state = {
      ...initialModel,
      connection: 'ready' as const,
      draft: 'Keep this',
      messages: [{ id: 0, kind: 'user' as const, text: 'Hello', date: '2026-10-12' }],
    }
    const reconnecting = receive(state, { _tag: 'Connecting' })
    expect(reconnecting.connection).toBe('connecting')
    expect(reconnecting.messages).toBe(state.messages)
    expect(reconnecting.draft).toBe(state.draft)
    expect(reconnecting.error).toBe('')
    const syncing = receive(reconnecting, { _tag: 'Ready', userId: 'alice' })
    expect(syncing.connection).toBe('syncing')
    expect(update(syncing, Message.Send({ steer: false })).commands).toBeUndefined()
    const ready = receive(syncing, {
      _tag: 'Snapshot',
      settings,
      hasApiKey: true,
      busy: false,
      turnId: null,
      messages: [],
    })
    expect(ready.connection).toBe('ready')
    expect(ready.messages).toBe(state.messages)
  })
  it('clears private state when the Clerk session changes', () => {
    const next = update(
      { ...initialModel, userId: 'alice', draft: 'Private', turnId: 'alice-turn' },
      Message.SessionChanged({ userId: 'bob' }),
    ).model
    expect(next.userId).toBe('bob')
    expect(next.draft).toBe('')
    expect(next.turnId).toBeNull()
    expect(next.generation).toBe(1)
  })
})

it('replaces an unsaved API draft after ChatGPT authorization even when SSE settings arrive first', () => {
  const draft = receive(initialModel, {
    _tag: 'Snapshot',
    settings,
    hasApiKey: true,
    messages: [],
    busy: false,
    turnId: null,
  })
  const edited = update(draft, Message.ChangedUrl({ value: 'https://unsaved.test/v1' })).model
  const chatGpt = {
    ...settings,
    provider: 'chatgpt' as const,
    baseUrl: 'https://chatgpt.com/backend-api/codex',
  }
  const synchronized = receive(edited, { _tag: 'SettingsChanged', settings: chatGpt })
  const connected = receive(synchronized, { _tag: 'ChatGptConnected', settings: chatGpt })
  expect(connected.provider).toBe('chatgpt')
  expect(connected.baseUrl).toBe(chatGpt.baseUrl)
  expect(connected.settingsDirty).toBe(false)
  expect(connected.deviceAuthorization).toBeNull()
})

describe('settings saves', () => {
  it.effect(
    'validates model edits and saves them in one action, updating references and effort',
    () =>
      Effect.gen(function* () {
        const active = {
          ...settings,
          memoryModelId: 'model',
          memoryThinking: 'high' as const,
          thinking: 'high' as const,
          models: [
            {
              ...modelMapping,
              thinking: { off: {}, high: { reasoning_effort: 'high' } },
            },
          ],
        }
        let state = receive(initialModel, {
          _tag: 'Snapshot',
          settings: active,
          hasApiKey: true,
          messages: [],
          busy: false,
          turnId: null,
        })
        state = update(state, Message.ChangedMapping({ field: 'id', value: 'renamed' })).model
        state = update(state, Message.ChangedMapping({ field: 'context', value: '64000' })).model
        state = update(state, Message.ToggledThinkingLevel({ level: 'high', enabled: false })).model
        const commands: ClientCommand[] = []
        const browser = Browser.of({
          firecrawl: () => Effect.succeed({ connected: false, usage: null }),
          connectFirecrawl: () => Effect.succeed({ connected: true, usage: null }),
          disconnectFirecrawl: () => Effect.succeed({ connected: false, usage: null }),
          upload: () => Effect.fail(new Error('Unavailable')),
          download: () => Effect.fail(new Error('Unavailable')),
          memory: () => Effect.succeed({ total: 0, start: 0, end: 0, tiles: [] }),
          memoryOriginal: () => Effect.succeed(null),
          sendSignInCode: () => Effect.void,
          verifySignInCode: () => Effect.void,
          sessionChanges: Stream.empty,
          connect: () => Stream.empty,
          signOut: Effect.void,
          send: (command) =>
            Effect.sync(() => {
              commands.push(command)
            }),
        })
        const validation = update(state, Message.Save()).commands?.[0]
        if (!validation) throw new Error('Missing validation')
        const validated = yield* validation.pipe(Effect.provideService(Browser, browser))
        const saved = update(state, validated)
        expect(saved.model.pendingSettings?.modelId).toBe('renamed')
        expect(saved.model.pendingSettings?.memoryModelId).toBe('renamed')
        expect(saved.model.pendingSettings?.thinking).toBe('off')
        expect(saved.model.pendingSettings?.memoryThinking).toBe('off')
        expect(saved.model.pendingSettings?.models[0]?.contextWindow).toBe(64000)
        const save = saved.commands?.[0]
        if (!save) throw new Error('Missing save')
        yield* save.pipe(Effect.provideService(Browser, browser))
        expect(commands).toHaveLength(1)
        expect(commands[0]?._tag).toBe('SaveSettings')
      }),
  )
  it('retains model customizations when refreshing the same provider', () => {
    const customized = { ...modelMapping, contextWindow: 64000 }
    const custom = { ...customized, id: 'custom' }
    const next = receive(
      {
        ...initialModel,
        activeSettings: settings,
        baseUrl: settings.baseUrl,
        modelId: 'model',
        memoryModelId: 'custom',
        models: [customized, custom],
      },
      {
        _tag: 'Models',
        models: [modelMapping, { ...customized, id: 'new' }],
      },
    )
    expect(next.models).toEqual([customized, custom, { ...customized, id: 'new' }])
    expect(next.modelId).toBe('model')
    expect(next.memoryModelId).toBe('custom')
  })
  it('replaces obsolete ChatGPT catalog entries while retaining available model settings', () => {
    const hidden = { ...modelMapping, id: 'codex-auto-review' }
    const customized = { ...modelMapping, contextWindow: 64000 }
    const next = receive(
      {
        ...initialModel,
        provider: 'chatgpt',
        activeSettings: { ...settings, provider: 'chatgpt' },
        baseUrl: settings.baseUrl,
        modelId: hidden.id,
        memoryModelId: hidden.id,
        models: [hidden, customized],
      },
      { _tag: 'Models', models: [{ ...modelMapping, displayName: 'Chat model' }] },
    )
    expect(next.models).toEqual([{ ...customized, displayName: 'Chat model' }])
    expect(next.modelId).toBe(modelMapping.id)
    expect(next.memoryModelId).toBe('')
    expect(next.settingsDirty).toBe(true)
    const refreshed = receive(next, {
      _tag: 'Models',
      models: [{ ...modelMapping, displayName: 'Chat model' }],
    })
    expect(refreshed.models).toEqual(next.models)
  })
  it('resets unavailable model choices when changing providers', () => {
    const mapping = {
      ...modelMapping,
      id: 'new-provider-model',
    }
    const next = receive(
      {
        ...initialModel,
        activeSettings: settings,
        baseUrl: 'https://new.test/v1',
        modelId: 'model',
        memoryModelId: 'model',
        thinking: 'high',
        models: settings.models,
      },
      { _tag: 'Models', models: [mapping] },
    )
    expect(next.models).toEqual([mapping])
    expect(next.modelId).toBe(mapping.id)
    expect(next.thinking).toBe('off')
    expect(next.memoryModelId).toBe('')
  })
})

describe('automatic settings saves', () => {
  const savedSettings: Settings = {
    ...settings,
    models: [{ ...modelMapping, thinking: { off: {}, low: {}, high: {} } }],
  }
  const ready = () =>
    receive(initialModel, {
      _tag: 'Snapshot',
      settings: savedSettings,
      hasApiKey: true,
      messages: [],
      busy: false,
      turnId: null,
      pending: [],
    })

  it('ignores an older debounce and saves the latest choice', () => {
    const first = update(ready(), Message.SelectedThinking({ value: 'high' })).model
    const latest = update(first, Message.SelectedThinking({ value: 'low' })).model
    expect(
      update(latest, Message.AutoSave({ revision: first.settingsRevision })).commands,
    ).toBeUndefined()
    const saving = update(latest, Message.AutoSave({ revision: latest.settingsRevision })).model
    expect(saving.pendingSettings?.thinking).toBe('low')
    expect(saving.saving).toBe(true)
  })

  it('retains edits and a replacement key made while an earlier save completes', () => {
    const edited = update(ready(), Message.SelectedThinking({ value: 'high' })).model
    const saving = update(edited, Message.AutoSave({ revision: edited.settingsRevision })).model
    const changed = update(saving, Message.ChangedKey({ value: 'replacement-test-key' })).model
    const latest = update(changed, Message.SelectedThinking({ value: 'low' })).model
    if (!saving.pendingSettings) throw new Error('Missing settings save')
    const notified = receive(latest, { _tag: 'SettingsChanged', settings: saving.pendingSettings })
    const completed = update(notified, Message.Received({ event: { _tag: 'Saved' } }))
    expect(completed.model.thinking).toBe('low')
    expect(completed.model.apiKey).toBe('replacement-test-key')
    expect(completed.model.settingsDirty).toBe(true)
    expect(completed.commands).toHaveLength(1)
    const next = update(
      completed.model,
      Message.AutoSave({ revision: latest.settingsRevision }),
    ).model
    expect(next.pendingSettings?.thinking).toBe('low')
    const finished = receive(next, { _tag: 'Saved' })
    expect(finished.settingsDirty).toBe(false)
    expect(finished.apiKey).toBe('')
  })

  it('defers changes until the active response finishes', () => {
    const edited = update(
      { ...ready(), busy: true },
      Message.SelectedThinking({ value: 'high' }),
    ).model
    expect(
      update(edited, Message.AutoSave({ revision: edited.settingsRevision })).model.saving,
    ).toBe(false)
    const idle = update(
      edited,
      Message.Received({ event: { _tag: 'Status', busy: false, turnId: null, pending: [] } }),
    )
    expect(idle.commands).toHaveLength(1)
    const saving = update(
      idle.model,
      Message.AutoSave({ revision: idle.model.settingsRevision }),
    ).model
    expect(saving.pendingSettings?.thinking).toBe('high')
  })

  it('does not install model validation results from an older edit', () => {
    const edited = update(
      ready(),
      Message.ChangedMapping({ field: 'context', value: '64000' }),
    ).model
    const latest = update(
      edited,
      Message.ChangedMapping({ field: 'context', value: '96000' }),
    ).model
    const result = update(
      latest,
      Message.ValidatedMapping({
        mapping: { ...modelMapping, contextWindow: 64000 },
        revision: edited.settingsRevision,
      }),
    )
    expect(result.model.models).toEqual(latest.models)
    expect(result.model.editingContext).toBe('96000')
    expect(result.model.saving).toBe(false)
  })
})

describe('provider tab switching', () => {
  it('restores saved ChatGPT models and effort after inspecting API key settings', () => {
    const chatGpt: Settings = {
      ...settings,
      provider: 'chatgpt',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      models: [{ ...modelMapping, thinking: { off: {}, high: {} } }],
      thinking: 'high',
      memoryModelId: 'model',
      memoryThinking: 'high',
    }
    const loaded = receive(initialModel, {
      _tag: 'Snapshot',
      settings: chatGpt,
      hasApiKey: true,
      messages: [],
      busy: false,
      turnId: null,
      pending: [],
    })
    const api = update(loaded, Message.SelectedProvider({ provider: 'api' })).model
    expect(api.hasApiKey).toBe(false)
    expect(api.models).toEqual([])
    const draft = update(api, Message.ChangedKey({ value: 'unsaved-test-key' })).model
    const restored = update(draft, Message.SelectedProvider({ provider: 'chatgpt' }))
    expect(restored.model.provider).toBe('chatgpt')
    expect(restored.model.hasApiKey).toBe(true)
    expect(restored.model.models).toEqual(chatGpt.models)
    expect(restored.model.modelId).toBe(chatGpt.modelId)
    expect(restored.model.thinking).toBe('high')
    expect(restored.model.memoryModelId).toBe('model')
    expect(restored.model.memoryThinking).toBe('high')
    expect(restored.model.apiKey).toBe('')
    expect(restored.model.settingsDirty).toBe(false)
    expect(restored.commands).toBeUndefined()
    expect(
      update(restored.model, Message.AutoSave({ revision: draft.settingsRevision })).commands,
    ).toBeUndefined()
  })
})

describe('API formats', () => {
  const connected: Model = {
    ...initialModel,
    connection: 'ready',
    baseUrl: settings.baseUrl,
    hasApiKey: true,
    activeSettings: settings,
    models: settings.models,
    modelId: 'model',
  }
  it('defaults older settings to Chat Completions', () => {
    const restored = receive(initialModel, { _tag: 'SettingsChanged', settings })
    expect(restored.apiFormat).toBe('chat-completions')
  })
  it('preserves a proxy credential but removes incompatible models when format changes', () => {
    const changed = update(
      { ...connected, apiKey: 'new-key' },
      Message.SelectedApiFormat({ format: 'responses' }),
    ).model
    expect(changed.baseUrl).toBe(settings.baseUrl)
    expect(changed.apiKey).toBe('new-key')
    expect(changed.hasApiKey).toBe(true)
    expect(changed.models).toEqual([])
    expect(changed.modelId).toBe('')
    const mapping = {
      ...modelMapping,
      thinking: { off: {}, low: { reasoning: { effort: 'low' } } },
    }
    const discovered = receive(changed, { _tag: 'Models', models: [mapping] })
    expect(discovered.models).toEqual([mapping])
    expect(discovered.settingsDirty).toBe(true)
  })
  it('clears credentials when switching the default provider host', () => {
    const changed = update(
      { ...connected, baseUrl: 'https://api.openai.com/v1', apiKey: 'openai-key' },
      Message.SelectedApiFormat({ format: 'anthropic' }),
    ).model
    expect(changed.baseUrl).toBe('https://api.anthropic.com/v1')
    expect(changed.apiKey).toBe('')
    expect(changed.hasApiKey).toBe(false)
  })
  it.effect('sends the selected format in discovery and autosave', () =>
    Effect.gen(function* () {
      const sent: ClientCommand[] = []
      const model = { ...connected, apiFormat: 'responses' as const, settingsDirty: true }
      const browser = Browser.of({
        firecrawl: () => Effect.succeed({ connected: false, usage: null }),
        connectFirecrawl: () => Effect.succeed({ connected: true, usage: null }),
        disconnectFirecrawl: () => Effect.succeed({ connected: false, usage: null }),
        upload: () => Effect.fail(new Error('Unavailable')),
        download: () => Effect.fail(new Error('Unavailable')),
        memory: () => Effect.succeed({ total: 0, start: 0, end: 0, tiles: [] }),
        memoryOriginal: () => Effect.succeed(null),
        sendSignInCode: () => Effect.void,
        verifySignInCode: () => Effect.void,
        send: (command) =>
          Effect.sync(() => {
            sent.push(command)
          }),
        connect: () => Stream.empty,
        sessionChanges: Stream.empty,
        signOut: Effect.void,
      })
      for (const action of [
        Message.Discover(),
        Message.AutoSave({ revision: model.settingsRevision }),
      ]) {
        const result = update(model, action)
        yield* Effect.forEach(result.commands ?? [], (command) => command).pipe(
          Effect.provideService(Browser, browser),
        )
      }
      expect(sent).toContainEqual({
        _tag: 'DiscoverModels',
        baseUrl: model.baseUrl,
        apiKey: '',
        apiFormat: 'responses',
      })
      expect(sent.find((command) => command._tag === 'SaveSettings')).toMatchObject({
        settings: { apiFormat: 'responses' },
      })
    }),
  )
})

it.effect('keeps replies through optimistic steering and restores them for editing', () =>
  Effect.gen(function* () {
    const reply = { id: 4, kind: 'talk' as const, text: 'The original answer.' }
    const attachment = { id: 'uploaded', name: 'notes.md', mediaType: 'text/markdown', size: 12 }
    const selected = update(
      {
        ...initialModel,
        activeSettings: settings,
        connection: 'ready',
        turnId: 'turn',
        draft: 'Explain this',
        attachments: [attachment],
      },
      Message.SelectedReply({ reply }),
    ).model
    const submission = update(selected, Message.Send({ steer: true }))
    const command = submission.commands?.[0]
    if (!command) throw new Error('Expected submission')
    const sent: ClientCommand[] = []
    const browser = Browser.of({
      firecrawl: () => Effect.succeed({ connected: false, usage: null }),
      connectFirecrawl: () => Effect.succeed({ connected: true, usage: null }),
      disconnectFirecrawl: () => Effect.succeed({ connected: false, usage: null }),
      upload: () => Effect.fail(new Error('Unavailable')),
      download: () => Effect.fail(new Error('Unavailable')),
      memory: () => Effect.succeed({ total: 0, start: 0, end: 0, tiles: [] }),
      memoryOriginal: () => Effect.succeed(null),
      sendSignInCode: () => Effect.void,
      verifySignInCode: () => Effect.void,
      send: (command) =>
        Effect.sync(() => {
          sent.push(command)
        }),
      connect: () => Stream.empty,
      sessionChanges: Stream.empty,
      signOut: Effect.void,
    })
    const prepared = yield* command.pipe(Effect.provideService(Browser, browser))
    expect(prepared._tag).toBe('PreparedSubmission')
    const submitted = update(submission.model, prepared)
    for (const effect of submitted.commands ?? [])
      yield* effect.pipe(Effect.provideService(Browser, browser))
    expect(sent[0]).toMatchObject({
      _tag: 'Steer',
      turnId: 'turn',
      replyTo: reply.id,
      attachmentIds: [attachment.id],
      text: 'Explain this',
    })
    const optimistic = submitted.model
    expect(optimistic.reply).toBeNull()
    expect(optimistic.attachments).toEqual([])
    expect(optimistic.draft).toBe('')
    expect(optimistic.pendingMessages[0]).toMatchObject({
      reply,
      attachments: [attachment],
      text: 'Explain this',
      mode: 'steer',
    })
    const pending = optimistic.pendingMessages[0]
    if (!pending) throw new Error('Expected pending reply')
    const edited = update(
      optimistic,
      Message.RetriedSubmission({ requestId: pending.requestId }),
    ).model
    expect(edited.reply).toEqual(reply)
    expect(edited.attachments).toEqual([attachment])
    expect(edited.draft).toBe('Explain this')
    expect(update(edited, Message.CancelledReply()).model.reply).toBeNull()
  }),
)

it.effect(
  'cancels one upload without accepting its late completion or blocking the remaining file',
  () =>
    Effect.sync(() => {
      const upload = {
        id: 'first',
        name: 'photo.png',
        mediaType: 'image/png',
        source: 'blob:preview',
        progress: 0,
      }
      let model = update(initialModel, Message.UploadStarted({ upload })).model
      model = update(model, Message.UploadStarted({ upload: { ...upload, id: 'second' } })).model
      model = update(model, Message.UploadProgress({ id: 'first', progress: 96 })).model
      expect(model.uploads[0]?.progress).toBe(96)
      model = update(model, Message.UploadCancelled({ id: 'first' })).model
      model = update(
        model,
        Message.AttachmentUploaded({
          id: 'first',
          attachment: { id: 'cancelled', name: 'photo.png', mediaType: 'image/png', size: 12 },
        }),
      ).model
      expect(model.attachments).toEqual([])
      expect(model.uploading).toBe(1)
      model = update(
        model,
        Message.AttachmentUploaded({
          id: 'second',
          attachment: { id: 'ready', name: 'photo.png', mediaType: 'image/png', size: 12 },
        }),
      ).model
      expect(model.uploading).toBe(0)
      expect(model.attachments.map((file) => file.id)).toEqual(['ready'])
    }),
)

it.effect('restores memory status on reconnect and clears it when processing finishes', () =>
  Effect.sync(() => {
    let model = update(
      initialModel,
      Message.Received({ event: { _tag: 'MemoryStatus', status: 'updating' } }),
    ).model
    expect(model.memoryStatus).toBe('updating')
    model = update(
      model,
      Message.Received({
        event: {
          _tag: 'Snapshot',
          memoryStatus: 'preparing',
          messages: [],
          settings: null,
          hasApiKey: false,
          busy: true,
          turnId: 'turn',
        },
      }),
    ).model
    expect(model.memoryStatus).toBe('preparing')
    model = update(
      model,
      Message.Received({ event: { _tag: 'MemoryStatus', status: 'idle' } }),
    ).model
    expect(model.memoryStatus).toBe('idle')
  }),
)

it.effect('keeps undelivered steering editable with its files and reply after Stop', () =>
  Effect.sync(() => {
    const attachment = { id: 'ready', name: 'notes.md', mediaType: 'text/markdown', size: 12 }
    const reply = { id: 4, kind: 'talk' as const, text: 'Original reply' }
    const waiting = {
      ...initialModel,
      pendingMessages: [
        {
          requestId: 'steer',
          mode: 'steer' as const,
          status: 'waiting' as const,
          text: 'Correction',
          attachments: [attachment],
          reply,
        },
      ],
    }
    const stopped = update(
      waiting,
      Message.Received({
        event: { _tag: 'Discarded', requestIds: ['steer'], message: 'Stopped', reason: 'stopped' },
      }),
    ).model
    expect(stopped.pendingMessages[0]?.status).toBe('cancelled')
    const restored = update(stopped, Message.RetriedSubmission({ requestId: 'steer' })).model
    expect(restored.draft).toBe('Correction')
    expect(restored.attachments).toEqual([attachment])
    expect(restored.reply).toEqual(reply)
    expect(restored.pendingMessages).toEqual([])
    const ended = update(
      waiting,
      Message.Received({
        event: { _tag: 'Discarded', requestIds: ['steer'], message: 'Ended', reason: 'ended' },
      }),
    ).model
    expect(ended.pendingMessages[0]?.status).toBe('discarded')
  }),
)

it.effect('updates activity rows in place and restores their completed status on reconnect', () =>
  Effect.sync(() => {
    const running: ChatMessage = {
      id: 3,
      date: '2026-10-14T00:00:00Z',
      kind: 'tool',
      text: '',
      activity: { id: 'call', name: 'web_search', input: 'Effect', status: 'running' },
    }
    let model: typeof initialModel = {
      ...initialModel,
      busy: true,
      turnId: 'current',
      messages: [running],
    }
    const completed: ChatMessage = {
      id: running.id,
      date: running.date,
      kind: running.kind,
      text: running.text,
      activity: {
        id: 'call',
        name: 'web_search',
        input: 'Effect',
        status: 'completed',
        output: 'Found docs',
      },
    }
    model = receive(model, { _tag: 'Message', message: completed })
    expect(model.messages).toEqual([completed])
    model = receive(model, { _tag: 'ResponsePhase', turnId: 'old', phase: 'responding' })
    expect(model.responsePhase).toBe('thinking')
    model = receive(model, { _tag: 'ResponsePhase', turnId: 'current', phase: 'responding' })
    expect(model.responsePhase).toBe('responding')
    model = receive(model, {
      _tag: 'Snapshot',
      messages: [completed],
      settings: null,
      hasApiKey: false,
      busy: true,
      turnId: 'current',
      responsePhase: 'thinking',
    })
    expect(model.responsePhase).toBe('thinking')
    expect(model.messages).toEqual([completed])
    model = receive(
      { ...model, messages: [running] },
      { _tag: 'Status', busy: false, turnId: null, pending: [] },
    )
    expect(model.messages[0]?.activity?.status).toBe('stopped')
  }),
)

it('replaces cleared conversations and ignores stale history and snapshots', () => {
  const old: ChatMessage = { id: 12, kind: 'user', text: 'Old message', date: '2026-10-14' }
  const fresh: ChatMessage = { id: 0, kind: 'talk', text: 'Fresh response', date: '2026-10-14' }
  const reset = receive(
    {
      ...initialModel,
      messages: [old],
      draft: 'Old draft',
      reply: { id: old.id, kind: 'user', text: old.text },
      loadingHistory: true,
    },
    {
      _tag: 'Snapshot',
      revision: 1,
      settings,
      hasApiKey: true,
      busy: false,
      turnId: null,
      messages: [fresh],
      hasOlder: false,
    },
  )
  expect(reset.messages).toEqual([fresh])
  expect(reset.draft).toBe('')
  expect(reset.reply).toBeNull()
  expect(reset.loadingHistory).toBe(false)
  expect(
    receive(reset, { _tag: 'History', revision: 0, messages: [old], hasOlder: false }).messages,
  ).toEqual([fresh])
  expect(
    receive(reset, {
      _tag: 'Snapshot',
      revision: 0,
      messages: [old],
      settings,
      hasApiKey: true,
      busy: false,
      turnId: null,
    }).messages,
  ).toEqual([fresh])
})
