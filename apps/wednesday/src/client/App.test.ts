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
