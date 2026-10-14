import { ResponsePhase } from '../shared/Activity.ts'
import { Attachment } from '../shared/Attachments.ts'
import { Effect, Schema } from 'effect'
import { PendingUpload, Message, matchMessage } from './Messages.ts'
import {
  editableFields,
  requestFields,
  removeField,
  ProviderField,
  FieldKind,
} from './ProviderFields.ts'
import {
  ChatMessage,
  MessageReply,
  StreamingMessage,
  MemoryStatus,
  PendingMessage,
  ModelMapping,
  DeviceAuthorization,
  ServerEvent,
  Thinking,
  ClientCommand,
  Settings,
  ApiFormat,
} from '../shared/protocol.ts'
import { defaultMemoryModelId } from '../shared/modelDefaults.ts'
import { Browser } from './Browser.ts'

const ThinkingEditor = Schema.Struct({
  level: Thinking,
  enabled: Schema.Boolean,
  fields: Schema.Array(ProviderField),
})

export const Model = Schema.Struct({
  provider: Schema.Literals(['api', 'chatgpt']),
  apiFormat: ApiFormat,
  deviceAuthorization: Schema.NullOr(DeviceAuthorization),
  deviceLoading: Schema.Boolean,
  deviceError: Schema.String,
  userId: Schema.String,
  activeSettings: Schema.NullOr(Settings),
  pendingSettings: Schema.NullOr(Settings),
  saving: Schema.Boolean,
  fetching: Schema.Boolean,
  loadingHistory: Schema.Boolean,
  hasOlder: Schema.Boolean,
  saveKind: Schema.Literals(['connection', 'selection']),
  settingsTab: Schema.Literals(['connection', 'models']),
  settingsDirty: Schema.Boolean,
  settingsRevision: Schema.Int,
  savingRevision: Schema.Int,
  settingsSaved: Schema.Int,
  turnId: Schema.NullOr(Schema.String),
  conversationRevision: Schema.Int,
  connection: Schema.Literals(['connecting', 'syncing', 'ready']),
  generation: Schema.Int,
  busy: Schema.Boolean,
  memoryStatus: MemoryStatus,
  responsePhase: ResponsePhase,
  page: Schema.Literals(['chat', 'settings']),
  draft: Schema.String,
  attachments: Schema.Array(Attachment),
  uploading: Schema.Int,
  uploads: Schema.Array(PendingUpload),
  reply: Schema.NullOr(MessageReply),
  error: Schema.String,
  notice: Schema.String,
  messages: Schema.Array(ChatMessage),
  streaming: Schema.NullOr(StreamingMessage),
  pendingMessages: Schema.Array(PendingMessage),

  baseUrl: Schema.String,
  apiKey: Schema.String,
  hasApiKey: Schema.Boolean,
  modelId: Schema.String,
  memoryModelId: Schema.String,
  memoryThinking: Thinking,
  thinking: Thinking,
  models: Schema.Array(ModelMapping),
  editingId: Schema.String,
  editingContext: Schema.String,
  editingOutput: Schema.String,
  editingFields: Schema.Array(ProviderField),
  editingLevels: Schema.Array(ThinkingEditor),
  editingOriginalId: Schema.String,
})
export type Model = typeof Model.Type
export { Message } from './Messages.ts'

const decodeFieldKind = Schema.decodeUnknownOption(FieldKind)

export const initialModel: Model = {
  provider: 'api',
  apiFormat: 'chat-completions',
  deviceAuthorization: null,
  deviceLoading: false,
  deviceError: '',
  userId: '',
  activeSettings: null,
  pendingSettings: null,
  saving: false,
  fetching: false,
  loadingHistory: false,
  hasOlder: false,
  saveKind: 'connection',
  settingsTab: 'connection',
  settingsDirty: false,
  settingsRevision: 0,
  savingRevision: 0,
  settingsSaved: 0,
  turnId: null,
  conversationRevision: 0,
  connection: 'connecting',
  generation: 0,
  busy: false,
  memoryStatus: 'idle',
  responsePhase: 'thinking',
  page: 'chat',
  draft: '',
  attachments: [],
  uploading: 0,
  uploads: [],
  reply: null,
  error: '',
  notice: '',
  messages: [],
  streaming: null,
  pendingMessages: [],

  baseUrl: '',
  apiKey: '',
  hasApiKey: false,
  modelId: '',
  memoryModelId: '',
  memoryThinking: 'off',
  thinking: 'off',
  models: [],
  editingId: '',
  editingContext: '128000',
  editingOutput: '8192',
  editingFields: [],
  editingOriginalId: '',
  editingLevels: Thinking.literals.map((level) => ({
    level,
    enabled: level === 'off',
    fields: [],
  })),
}
type UpdateResult = {
  readonly model: Model
  readonly commands?: readonly Effect.Effect<Message, never, Browser>[]
}
const send = (command: ClientCommand) =>
  Effect.gen(function* () {
    const browser = yield* Browser
    yield* browser.send(command)
    return Message.Completed()
  }).pipe(Effect.catch((error) => Effect.succeed(Message.Failed({ message: error.message }))))
const decodeMapping = Schema.decodeUnknownEffect(ModelMapping)
const parseThinking = Schema.decodeUnknownOption(Thinking)
const validateEditor = (input: {
  revision: number
  id: string
  context: string
  output: string
  fields: readonly ProviderField[]
  levels: readonly (typeof ThinkingEditor.Type)[]
}) =>
  Effect.gen(function* () {
    const fields = yield* requestFields(input.fields)
    const entries = yield* Effect.forEach(
      input.levels.filter((row) => row.enabled),
      (row) => requestFields(row.fields).pipe(Effect.map((fields) => [row.level, fields] as const)),
    )
    const mapping = yield* decodeMapping({
      id: input.id,
      contextWindow: Number(input.context),
      maxOutputTokens: Number(input.output),
      requestFields: fields,
      thinking: Object.fromEntries(entries),
    }).pipe(
      Effect.mapError(
        () => new Error('Enter a model name and positive context and response limits.'),
      ),
    )
    return Message.ValidatedMapping({ mapping, revision: input.revision })
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Message.Failed({
          message:
            error instanceof Error ? error.message : 'Check the model name and positive limits.',
        }),
      ),
    ),
  )
const prepareMessage = ({
  text,
  turnId,
  reply,
  attachments,
}: {
  attachments: readonly Attachment[]
  text: string
  turnId: string | null
  reply: MessageReply | null
}) =>
  Effect.sync(() => {
    const submission: Extract<Message, { _tag: 'PreparedSubmission' }> = Message.PreparedSubmission(
      {
        attachments,
        requestId: crypto.randomUUID(),
        text,
        date: new Date().toISOString(),
        mode: turnId ? 'steer' : 'send',
        turnId,
      },
    )
    return reply ? { ...submission, reply } : submission
  })
type SubmissionReference = { replyTo?: number; attachmentIds?: readonly string[] }
const submitMessage = ({
  requestId,
  text,
  mode,
  turnId,
  reply,
  attachments,
}: {
  attachments?: readonly Attachment[]
  requestId: string
  text: string
  mode: 'send' | 'steer'
  reply?: MessageReply
  turnId?: string | null
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser
    const reference: SubmissionReference = {}
    if (attachments?.length) reference.attachmentIds = attachments.map((file) => file.id)
    if (reply) reference.replyTo = reply.id
    if (mode === 'steer') {
      if (!turnId)
        return yield* Effect.fail(
          new Error('That response has ended. Edit your message to send it again.'),
        )
      yield* browser.send({
        _tag: 'Steer',
        requestId,
        text,
        turnId,
        ...reference,
      })
    } else
      yield* browser.send({
        _tag: 'Send',
        requestId,
        text,
        ...reference,
      })
    return Message.Completed()
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(Message.SubmissionFailed({ requestId, message: error.message })),
    ),
  )
const stopTurn = (turnId: string | null) =>
  Effect.gen(function* () {
    const browser = yield* Browser
    if (turnId) yield* browser.send({ _tag: 'Stop', turnId })
    return Message.Completed()
  }).pipe(Effect.catch((error) => Effect.succeed(Message.Failed({ message: error.message }))))
const mappingEditor = (model: Model, mapping: ModelMapping): Model => ({
  ...model,
  editingId: mapping.id,
  editingContext: String(mapping.contextWindow),
  editingOutput: String(mapping.maxOutputTokens),
  editingFields: editableFields(mapping.requestFields),
  editingOriginalId: mapping.id,
  editingLevels: Thinking.literals.map((level) => ({
    level,
    enabled: mapping.thinking[level] !== undefined,
    fields: editableFields(
      mapping.thinking[level] ?? (level === 'off' ? {} : { reasoning_effort: level }),
    ),
  })),
})
// Merge indexed history without replacing rows already rendered in the timeline.
const mergeMessages = (current: Model['messages'], incoming: Model['messages']) => {
  const ids = new Set(current.map((item) => item.id))
  const added = incoming.filter((item) => !ids.has(item.id))
  const updates = new Map(incoming.filter((item) => item.activity).map((item) => [item.id, item]))
  const restored = updates.size ? current.map((item) => updates.get(item.id) ?? item) : current
  return added.length ? [...restored, ...added].sort((a, b) => a.id - b.id) : restored
}
const reconcilePending = (
  model: Model,
  pending: Model['pendingMessages'],
  messages = model.messages,
) => {
  const live = pending.filter(
    (item) => !messages.some((message) => message.requestId === item.requestId),
  )
  return [
    ...live,
    ...model.pendingMessages
      .filter(
        (item) =>
          !live.some((row) => row.requestId === item.requestId) &&
          !messages.some((message) => message.requestId === item.requestId),
      )
      .map((item) =>
        item.status === 'waiting' ? { ...item, status: 'discarded' as const } : item,
      ),
  ]
}
const settingsDraft = (model: Model, settings: Settings): Model => {
  const next = {
    ...model,
    provider: settings.provider ?? 'api',
    apiFormat: settings.apiFormat ?? 'chat-completions',
    baseUrl: settings.baseUrl,
    modelId: settings.modelId,
    memoryModelId: settings.memoryModelId ?? defaultMemoryModelId(settings.models),
    thinking: settings.thinking,
    memoryThinking: settings.memoryThinking ?? 'off',
    models: settings.models,
  }
  const mapping = settings.models.find((item) => item.id === settings.modelId)
  return mapping ? mappingEditor(next, mapping) : next
}
const saveSettings = (model: Model): UpdateResult => {
  const settings: Settings = {
    provider: model.provider,
    apiFormat: model.apiFormat,
    baseUrl: model.baseUrl,
    modelId: model.modelId,
    thinking: model.thinking,
    models: model.models,
    memoryModelId: model.memoryModelId,
    memoryThinking: model.memoryThinking,
  }
  return {
    model: {
      ...model,
      error: '',
      notice: '',
      saving: true,
      pendingSettings: settings,
      saveKind: 'connection',
      savingRevision: model.settingsRevision,
    },
    commands: [send({ _tag: 'SaveSettings', settings, apiKey: model.apiKey })],
  }
}
const validateModel = (model: Model): UpdateResult => ({
  model,
  commands: [
    validateEditor({
      revision: model.settingsRevision,
      id: model.editingId,
      context: model.editingContext,
      output: model.editingOutput,
      fields: model.editingFields,
      levels: model.editingLevels,
    }),
  ],
})
const modelHasChanges = (model: Model) => {
  const mapping = model.models.find((item) => item.id === model.editingOriginalId)
  if (!mapping) return !!model.editingId.trim()
  const original = mappingEditor(model, mapping)
  return (
    model.editingId !== original.editingId ||
    model.editingContext !== original.editingContext ||
    model.editingOutput !== original.editingOutput ||
    JSON.stringify(model.editingFields) !== JSON.stringify(original.editingFields) ||
    JSON.stringify(model.editingLevels) !== JSON.stringify(original.editingLevels)
  )
}
const received = (model: Model, event: ServerEvent): UpdateResult =>
  ServerEvent.match<UpdateResult>(event, {
    ChatGptAuthorization: (event) => ({
      model: {
        ...model,
        deviceAuthorization: event.authorization,
        deviceLoading: false,
        deviceError: '',
      },
    }),
    ChatGptPending: (event) => ({
      model:
        model.deviceAuthorization?.attemptId === event.attemptId
          ? { ...model, deviceLoading: false }
          : model,
    }),
    ChatGptConnected: (event) => ({
      model: settingsDraft(
        {
          ...model,
          deviceAuthorization: null,
          deviceLoading: false,
          deviceError: '',
          settingsDirty: false,
          error: '',
          notice: '',
          activeSettings: event.settings,
          hasApiKey: true,
        },
        event.settings,
      ),
    }),
    ChatGptCancelled: () => ({
      model: { ...model, deviceAuthorization: null, deviceLoading: false, deviceError: '' },
    }),
    Connecting: () => ({ model: { ...model, connection: 'connecting' } }),
    Ready: () => ({ model: { ...model, connection: 'syncing' } }),
    Heartbeat: () => ({ model }),
    Snapshot: (event) => {
      const revision = event.revision ?? 0
      if (revision < model.conversationRevision) return { model }
      const base: Model =
        revision !== model.conversationRevision
          ? {
              ...model,
              conversationRevision: revision,
              messages: [],
              pendingMessages: [],
              draft: '',
              reply: null,
              attachments: [],
              uploads: [],
              uploading: 0,
              hasOlder: false,
              loadingHistory: false,
              error: '',
              notice: '',
            }
          : model
      const messages = mergeMessages(base.messages, event.messages)
      const next: Model = {
        ...base,
        connection: 'ready',
        memoryStatus: event.memoryStatus ?? 'idle',
        responsePhase: event.responsePhase ?? 'thinking',
        hasOlder: event.hasOlder ?? base.hasOlder,
        messages,
        streaming: event.streaming ?? null,
        pendingMessages: reconcilePending(base, event.pending ?? [], messages),
        activeSettings: event.settings,
        busy: event.busy,
        turnId: event.turnId,
        hasApiKey: event.hasApiKey,
        deviceLoading: model.deviceAuthorization ? model.deviceLoading : false,
      }
      return {
        model:
          event.settings &&
          !model.settingsDirty &&
          JSON.stringify(model.activeSettings) !== JSON.stringify(event.settings)
            ? settingsDraft(next, event.settings)
            : next,
      }
    },
    SettingsChanged: (event) => {
      const next = { ...model, activeSettings: event.settings, hasApiKey: true }
      return { model: model.settingsDirty ? next : settingsDraft(next, event.settings) }
    },
    Discarded: (event) => ({
      model: {
        ...model,
        pendingMessages: model.pendingMessages.map((item) =>
          event.requestIds.includes(item.requestId) && item.status !== 'failed'
            ? { ...item, status: event.reason === 'stopped' ? 'cancelled' : 'discarded' }
            : item,
        ),
      },
    }),
    History: (event) => ({
      model:
        (event.revision ?? 0) !== model.conversationRevision
          ? model
          : {
              ...model,
              messages: mergeMessages(model.messages, event.messages),
              hasOlder: event.hasOlder,
              loadingHistory: false,
            },
    }),
    Models: (event) => {
      const sameProvider =
        !model.activeSettings ||
        (model.baseUrl === model.activeSettings.baseUrl &&
          model.provider === (model.activeSettings.provider ?? 'api') &&
          model.apiFormat === (model.activeSettings.apiFormat ?? 'chat-completions'))
      const models =
        model.provider === 'chatgpt'
          ? event.models.map((discovered) => {
              const saved = model.models.find((item) => item.id === discovered.id)
              if (!saved) return discovered
              return discovered.displayName
                ? { ...saved, displayName: discovered.displayName }
                : saved
            })
          : sameProvider
            ? [
                ...model.models.map((mapping) => {
                  const discovered = event.models.find((item) => item.id === mapping.id)
                  return discovered?.displayName
                    ? { ...mapping, displayName: discovered.displayName }
                    : mapping
                }),
                ...event.models.filter(
                  (item) => !model.models.some((saved) => saved.id === item.id),
                ),
              ]
            : event.models
      const selected = models.find((item) => item.id === model.modelId) ?? models[0]
      const next = {
        ...model,
        models,
        settingsDirty:
          model.settingsDirty || JSON.stringify(models) !== JSON.stringify(model.models),
        memoryModelId:
          model.activeSettings &&
          sameProvider &&
          (!model.memoryModelId || models.some((item) => item.id === model.memoryModelId))
            ? model.memoryModelId
            : defaultMemoryModelId(event.models),
        memoryThinking: sameProvider ? model.memoryThinking : ('off' as const),
        fetching: false,
        modelId: selected?.id ?? '',
        thinking:
          selected?.thinking[model.thinking] !== undefined ? model.thinking : ('off' as const),
        notice: '',
      }
      return { model: selected ? mappingEditor(next, selected) : next }
    },
    Saved: () => ({
      model: {
        ...model,
        pendingSettings: null,
        saving: false,
        settingsDirty: model.settingsRevision !== model.savingRevision,
        apiKey: model.settingsRevision === model.savingRevision ? '' : model.apiKey,
        hasApiKey: true,
        settingsSaved: model.settingsSaved + 1,
        notice: '',
      },
    }),
    Accepted: (event) => ({
      model: {
        ...model,
        pendingMessages: model.pendingMessages.map((item) =>
          item.requestId === event.requestId
            ? { ...item, mode: event.mode, status: 'waiting' }
            : item,
        ),
      },
    }),
    Streaming: (event) => ({ model: { ...model, streaming: event.message } }),
    Message: (event) => ({
      model: {
        ...model,
        pendingMessages: model.pendingMessages.filter(
          (item) => item.requestId !== event.message.requestId,
        ),
        messages: mergeMessages(model.messages, [event.message]),
        streaming: event.completesStreaming ? null : model.streaming,
      },
    }),
    ResponsePhase: (event) => ({
      model: model.turnId === event.turnId ? { ...model, responsePhase: event.phase } : model,
    }),
    MemoryStatus: (event) => ({ model: { ...model, memoryStatus: event.status } }),
    Status: (event) => ({
      model: {
        ...model,
        busy: event.busy,
        messages: event.busy
          ? model.messages
          : model.messages.map((item) =>
              item.activity?.status === 'running'
                ? { ...item, activity: { ...item.activity, status: 'stopped' as const } }
                : item,
            ),
        responsePhase: event.turnId === model.turnId ? model.responsePhase : 'thinking',
        streaming: event.busy ? model.streaming : null,
        turnId: event.turnId,
        pendingMessages: reconcilePending(model, event.pending),
      },
    }),
    Error: (event) => ({
      model: {
        ...model,
        error: event.message,
        pendingMessages: model.pendingMessages.map((item) =>
          item.requestId === event.requestId ? { ...item, status: 'failed' } : item,
        ),
        saving: false,
        fetching: false,
        pendingSettings: null,
        loadingHistory: false,
      },
    }),
  })
const reduce = (model: Model, message: Message): UpdateResult =>
  matchMessage<UpdateResult>(message, {
    SessionChanged: (message) => ({
      model:
        message.userId === model.userId
          ? model
          : { ...initialModel, userId: message.userId, generation: model.generation + 1 },
    }),
    Received: (message) => received(model, message.event),
    Failed: (message) => ({
      model: {
        ...model,
        deviceLoading: false,
        loadingHistory: false,
        deviceError:
          model.deviceAuthorization || model.deviceLoading ? message.message : model.deviceError,
        error: message.message,
        saving: false,
        fetching: false,
        pendingSettings: null,
      },
    }),
    Completed: () => ({ model }),
    SelectedProvider: (message) => {
      if (message.provider === model.provider) return { model }
      if ((model.activeSettings?.provider ?? 'api') === message.provider && model.activeSettings)
        return {
          model: settingsDraft(
            {
              ...model,
              apiKey: '',
              hasApiKey: !!model.activeSettings.modelId,
              settingsDirty: false,
              error: '',
              notice: '',
            },
            model.activeSettings,
          ),
        }
      return {
        model: {
          ...model,
          provider: message.provider,
          apiFormat: 'chat-completions',
          baseUrl:
            message.provider === 'api'
              ? 'https://api.openai.com/v1'
              : 'https://chatgpt.com/backend-api/codex',
          apiKey: '',
          hasApiKey: false,
          models: [],
          modelId: '',
          memoryModelId: '',
          thinking: 'off',
          memoryThinking: 'off',
          editingId: '',
          editingOriginalId: '',
          settingsDirty: true,
        },
      }
    },
    SelectedApiFormat: (message) => {
      if (message.format === model.apiFormat) return { model }
      const defaultUrl =
        !model.baseUrl ||
        ['https://api.openai.com/v1', 'https://api.anthropic.com/v1'].includes(model.baseUrl)
      const baseUrl = defaultUrl
        ? message.format === 'anthropic'
          ? 'https://api.anthropic.com/v1'
          : 'https://api.openai.com/v1'
        : model.baseUrl
      return {
        model: {
          ...model,
          apiFormat: message.format,
          baseUrl,
          apiKey: baseUrl === model.baseUrl ? model.apiKey : '',
          hasApiKey: baseUrl === model.baseUrl ? model.hasApiKey : false,
          models: [],
          modelId: '',
          memoryModelId: '',
          thinking: 'off',
          memoryThinking: 'off',
          editingId: '',
          editingOriginalId: '',
          editingFields: [],
          editingLevels: [],
          error: '',
          notice: '',
        },
      }
    },
    StartChatGpt: () => ({
      model: {
        ...model,
        deviceLoading: true,
        deviceAuthorization: null,
        deviceError: '',
        error: '',
      },
      commands: [send({ _tag: 'StartChatGpt' })],
    }),
    PollChatGpt: () =>
      model.deviceAuthorization && !model.deviceLoading && !model.deviceError
        ? {
            model: { ...model, deviceLoading: true },
            commands: [
              send({ _tag: 'PollChatGpt', attemptId: model.deviceAuthorization.attemptId }),
            ],
          }
        : { model },
    CancelChatGpt: () => ({
      model: { ...model, deviceLoading: false, deviceAuthorization: null, deviceError: '' },
      commands: model.deviceAuthorization
        ? [send({ _tag: 'CancelChatGpt', attemptId: model.deviceAuthorization.attemptId })]
        : [],
    }),
    DisconnectChatGpt: () => ({
      model: { ...model, deviceLoading: true, settingsDirty: false },
      commands: [send({ _tag: 'DisconnectChatGpt' })],
    }),
    SelectedReply: (message) => ({ model: { ...model, reply: message.reply } }),
    CancelledReply: () => ({ model: { ...model, reply: null } }),
    UploadStarted: ({ upload }) => ({
      model: { ...model, uploading: model.uploading + 1, uploads: [...model.uploads, upload] },
    }),
    UploadProgress: ({ id, progress }) => ({
      model: {
        ...model,
        uploads: model.uploads.map((upload) =>
          upload.id === id ? { ...upload, progress } : upload,
        ),
      },
    }),
    UploadCancelled: ({ id }) => ({
      model: {
        ...model,
        uploads: model.uploads.filter((upload) => upload.id !== id),
        uploading: model.uploads.filter((upload) => upload.id !== id).length,
      },
    }),
    AttachmentUploaded: ({ id, attachment }) => ({
      model: model.uploads.some((upload) => upload.id === id)
        ? {
            ...model,
            uploads: model.uploads.filter((upload) => upload.id !== id),
            uploading: model.uploads.length - 1,
            attachments: [...model.attachments, attachment],
          }
        : model,
    }),
    UploadFailed: ({ id, message }) => ({
      model: model.uploads.some((upload) => upload.id === id)
        ? {
            ...model,
            uploads: model.uploads.filter((upload) => upload.id !== id),
            uploading: model.uploads.length - 1,
            error: message,
          }
        : model,
    }),
    RemovedAttachment: (message) => ({
      model: { ...model, attachments: model.attachments.filter((file) => file.id !== message.id) },
    }),
    ChangedDraft: (message) => ({ model: { ...model, draft: message.value } }),
    ChangedUrl: (message) => ({ model: { ...model, baseUrl: message.value } }),
    ChangedKey: (message) => ({ model: { ...model, apiKey: message.value } }),
    SelectedThinking: (message) => {
      const value = parseThinking(message.value)
      return { model: { ...model, thinking: value._tag === 'Some' ? value.value : 'off' } }
    },
    SelectedMemoryThinking: (message) => {
      const value = parseThinking(message.value)
      return { model: { ...model, memoryThinking: value._tag === 'Some' ? value.value : 'off' } }
    },
    SelectedMemoryModel: (message) => ({
      model: { ...model, memoryModelId: message.id, memoryThinking: 'off' },
    }),
    SelectedModel: (message) => ({
      model: {
        ...model,
        modelId: message.id,
        thinking: 'off',
        memoryThinking: model.memoryModelId ? model.memoryThinking : 'off',
      },
    }),
    OpenedPage: (message) => ({ model: { ...model, page: message.page, error: '', notice: '' } }),
    Reconnect: () => ({
      model: { ...model, generation: model.generation + 1, connection: 'connecting', error: '' },
    }),
    Send: () =>
      (model.draft.trim() || model.attachments.length) &&
      !model.uploading &&
      model.connection === 'ready' &&
      model.activeSettings &&
      !model.saving
        ? {
            model: { ...model, error: '', notice: '' },
            commands: [
              prepareMessage({
                text: model.draft || 'Attached files',
                turnId: model.turnId,
                reply: model.reply,
                attachments: model.attachments,
              }),
            ],
          }
        : { model },
    PreparedSubmission: (message) => {
      const pending = {
        requestId: message.requestId,
        text: message.text,
        mode: message.mode,
        date: message.date,
        status: 'sending',
        attachments: message.attachments,
        turnId: message.turnId ?? message.requestId,
      } satisfies PendingMessage
      return {
        model: {
          ...model,
          draft: model.draft === message.text ? '' : model.draft,
          attachments: model.attachments.filter(
            (file) => !message.attachments.some((sent) => sent.id === file.id),
          ),
          reply: model.reply?.id === message.reply?.id ? null : model.reply,
          pendingMessages: [
            ...model.pendingMessages,
            message.reply ? { ...pending, reply: message.reply } : pending,
          ],
        },
        commands: [submitMessage(message)],
      }
    },
    SubmissionFailed: (message) => ({
      model: {
        ...model,
        pendingMessages: model.pendingMessages.map((item) =>
          item.requestId === message.requestId ? { ...item, status: 'failed' } : item,
        ),
      },
    }),
    RetriedSubmission: (message) => {
      const item = model.pendingMessages.find((item) => item.requestId === message.requestId)
      return item
        ? {
            model: {
              ...model,
              draft: item.text,
              attachments: item.attachments ?? [],
              reply: item.reply ?? null,
              pendingMessages: model.pendingMessages.filter(
                (row) => row.requestId !== item.requestId,
              ),
            },
          }
        : { model }
    },
    Stop: () => ({ model, commands: [stopTurn(model.turnId)] }),
    SignOut: () => ({
      model,
      commands: [
        Effect.gen(function* () {
          const browser = yield* Browser
          yield* browser.signOut
          return Message.Completed()
        }).pipe(
          Effect.catch((error) => Effect.succeed(Message.Failed({ message: error.message }))),
        ),
      ],
    }),
    ResetSettings: () => ({
      model: model.activeSettings
        ? {
            ...settingsDraft(model, model.activeSettings),
            settingsDirty: false,
            apiKey: '',
            error: '',
            notice: '',
          }
        : model,
    }),
    CancelMapping: () => {
      const mapping = model.models.find((item) => item.id === model.editingOriginalId)
      return { model: mapping ? mappingEditor(model, mapping) : model }
    },
    LoadOlder: () =>
      model.hasOlder && !model.loadingHistory && model.connection === 'ready' && model.messages[0]
        ? {
            model: { ...model, loadingHistory: true },
            commands: [send({ _tag: 'LoadOlder', beforeId: model.messages[0].id })],
          }
        : { model },
    Discover: () => {
      const command: Extract<ClientCommand, { _tag: 'DiscoverModels' }> =
        model.provider === 'api'
          ? {
              _tag: 'DiscoverModels',
              baseUrl: model.baseUrl,
              apiKey: model.apiKey,
              apiFormat: model.apiFormat,
            }
          : { _tag: 'DiscoverModels', baseUrl: model.baseUrl, apiKey: model.apiKey }
      return {
        model: { ...model, error: '', notice: '', fetching: true },
        commands: [send(command)],
      }
    },
    Save: () =>
      model.saving || model.busy
        ? { model }
        : modelHasChanges(model)
          ? validateModel(model)
          : saveSettings(model),
    AutoSave: (message) =>
      message.revision === model.settingsRevision && canAutoSave(model)
        ? modelHasChanges(model)
          ? validateModel(model)
          : saveSettings(model)
        : { model },
    SelectedMapping: (message) => {
      const mapping = model.models.find((item) => item.id === message.id)
      return { model: mapping ? mappingEditor(model, mapping) : model }
    },
    ChangedMapping: (message) => {
      const fields = {
        id: 'editingId',
        context: 'editingContext',
        output: 'editingOutput',
      } as const
      return { model: { ...model, [fields[message.field]]: message.value } }
    },
    AppliedMapping: () => validateModel(model),
    ValidatedMapping: (message) => {
      if (message.revision !== undefined && message.revision !== model.settingsRevision)
        return { model }
      const next = {
        ...model,
        models: [
          ...model.models.filter(
            (item) => item.id !== model.editingOriginalId && item.id !== message.mapping.id,
          ),
          { ...model.models.find((item) => item.id === message.mapping.id), ...message.mapping },
        ],
        editingOriginalId: message.mapping.id,
        modelId:
          model.modelId === model.editingOriginalId || !model.modelId
            ? message.mapping.id
            : model.modelId,
        memoryModelId:
          model.memoryModelId && model.memoryModelId === model.editingOriginalId
            ? message.mapping.id
            : model.memoryModelId,
      }
      const selected = next.models.find((item) => item.id === next.modelId)
      const memory = next.models.find((item) => item.id === (next.memoryModelId || next.modelId))
      return saveSettings({
        ...next,
        thinking: selected?.thinking[model.thinking] !== undefined ? model.thinking : 'off',
        memoryThinking:
          memory?.thinking[model.memoryThinking] !== undefined ? model.memoryThinking : 'off',
      })
    },
    SelectedSettingsTab: (message) => ({ model: { ...model, settingsTab: message.tab } }),
    ToggledReasoning: () => ({ model }),
    DismissedFeedback: () => ({ model: { ...model, error: '', notice: '' } }),
    AddedProviderField: (message) => ({
      model: editFields(model, message.target, (rows) => [
        ...rows,
        {
          id: Math.max(-1, ...rows.map((row) => row.id)) + 1,
          parentId: message.parentId,
          name: '',
          kind: 'text',
          value: '',
        },
      ]),
    }),
    RemovedProviderField: (message) => ({
      model: editFields(model, message.target, (rows) => removeField(rows, message.id)),
    }),
    ChangedProviderField: (message) => ({
      model: editFields(model, message.target, (rows) => {
        const kind = message.field === 'kind' ? decodeFieldKind(message.value) : null
        const childrenRemoved = message.field === 'kind' ? removeField(rows, message.id) : rows
        const keepIds = new Set(childrenRemoved.map((row) => row.id))
        return rows
          .filter((row) => row.id === message.id || keepIds.has(row.id))
          .map((row) =>
            row.id !== message.id
              ? row
              : message.field === 'kind'
                ? { ...row, kind: kind?._tag === 'Some' ? kind.value : row.kind, value: '' }
                : { ...row, [message.field]: message.value },
          )
      }),
    }),
    ToggledThinkingLevel: (message) => ({
      model: {
        ...model,
        editingLevels: model.editingLevels.map((row) =>
          row.level === message.level ? { ...row, enabled: message.enabled } : row,
        ),
      },
    }),
    PickedChatModel: (message) =>
      selectActiveSettings(model, { modelId: message.id, thinking: 'off' }),
    PickedChatThinking: (message) => selectActiveSettings(model, { thinking: message.value }),
    NewMapping: () => ({
      model: {
        ...model,
        editingId: '',
        editingContext: '128000',
        editingOutput: '8192',
        editingFields: [],
        editingOriginalId: '',
        editingLevels: Thinking.literals.map((level) => ({
          level,
          enabled: level === 'off',
          fields: editableFields(level === 'off' ? {} : { reasoning_effort: level }),
        })),
      },
    }),
  })
const editFields = (
  model: Model,
  target: string,
  edit: (rows: readonly ProviderField[]) => readonly ProviderField[],
): Model =>
  target === 'extra'
    ? { ...model, editingFields: edit(model.editingFields) }
    : {
        ...model,
        editingLevels: model.editingLevels.map((row) =>
          row.level === target ? { ...row, fields: edit(row.fields) } : row,
        ),
      }

const selectActiveSettings = (
  model: Model,
  selection: Partial<Pick<Settings, 'modelId' | 'thinking'>>,
): UpdateResult => {
  if (!model.activeSettings || model.busy || model.saving || model.connection !== 'ready')
    return { model }
  const settings = { ...model.activeSettings, ...selection }
  return {
    model: {
      ...model,
      pendingSettings: settings,
      saving: true,
      savingRevision: model.settingsRevision,
      saveKind: 'selection',
      error: '',
    },
    commands: [send({ _tag: 'SaveSettings', settings, apiKey: '' })],
  }
}

const canAutoSave = (model: Model) =>
  model.settingsDirty &&
  !model.saving &&
  !model.busy &&
  !model.fetching &&
  model.connection === 'ready' &&
  !!model.modelId &&
  URL.canParse(model.baseUrl) &&
  !!(model.apiKey || model.hasApiKey) &&
  (model.provider !== 'chatgpt' || model.activeSettings?.provider === 'chatgpt')

const scheduleSave = (result: UpdateResult): UpdateResult => ({
  ...result,
  commands: [
    ...(result.commands ?? []),
    Effect.sleep('600 millis').pipe(
      Effect.as(Message.AutoSave({ revision: result.model.settingsRevision })),
    ),
  ],
})

export const update = (model: Model, message: Message): UpdateResult => {
  const result = reduce(model, message)
  switch (message._tag) {
    case 'SelectedProvider':
      return result.model === model
        ? result
        : { ...result, model: { ...result.model, settingsRevision: model.settingsRevision + 1 } }
    case 'SelectedApiFormat':
    case 'ChangedUrl':
    case 'ChangedKey':
    case 'SelectedModel':
    case 'SelectedMemoryModel':
    case 'SelectedThinking':
    case 'SelectedMemoryThinking':
    case 'ChangedMapping':
    case 'AddedProviderField':
    case 'RemovedProviderField':
    case 'ChangedProviderField':
    case 'ToggledThinkingLevel':
      return scheduleSave({
        ...result,
        model: {
          ...result.model,
          settingsDirty: true,
          settingsRevision: model.settingsRevision + 1,
        },
      })
    case 'ValidatedMapping':
      return { ...result, model: { ...result.model, settingsDirty: true } }
    case 'Received':
      if (
        ['Models', 'Saved', 'Status', 'Snapshot'].includes(message.event._tag) &&
        canAutoSave(result.model)
      )
        return scheduleSave(result)
      return result
    default:
      return result
  }
}
