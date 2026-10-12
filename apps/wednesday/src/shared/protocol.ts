import { Schema } from 'effect'

export const Thinking = Schema.Literals(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export type Thinking = typeof Thinking.Type
export const RequestFields = Schema.Record(Schema.String, Schema.Json)
export const ModelMapping = Schema.Struct({
  id: Schema.NonEmptyString,
  displayName: Schema.optionalKey(Schema.String),
  contextWindow: Schema.Int.check(Schema.isGreaterThan(0)),
  maxOutputTokens: Schema.Int.check(Schema.isGreaterThan(0)),
  requestFields: RequestFields,
  thinking: Schema.Struct({
    off: RequestFields,
    minimal: Schema.optionalKey(RequestFields),
    low: Schema.optionalKey(RequestFields),
    medium: Schema.optionalKey(RequestFields),
    high: Schema.optionalKey(RequestFields),
    xhigh: Schema.optionalKey(RequestFields),
    max: Schema.optionalKey(RequestFields),
  }),
})
export interface ModelMapping extends Schema.Schema.Type<typeof ModelMapping> {}
export const DeviceAuthorization = Schema.Struct({
  attemptId: Schema.String,
  userCode: Schema.String,
  verificationUrl: Schema.String,
  expiresAt: Schema.Number,
  intervalSeconds: Schema.Number,
})
export type DeviceAuthorization = typeof DeviceAuthorization.Type
export const Settings = Schema.Struct({
  provider: Schema.optionalKey(Schema.Literals(['api', 'chatgpt'])),
  baseUrl: Schema.NonEmptyString,
  modelId: Schema.String,
  thinking: Thinking,
  models: Schema.Array(ModelMapping),
  memoryModelId: Schema.optionalKey(Schema.String),
  memoryThinking: Schema.optionalKey(Thinking),
})
export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const ChatMessage = Schema.Struct({
  id: Schema.Int,
  requestId: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(['user', 'talk', 'tool', 'echo']),
  text: Schema.String,
  date: Schema.String,
})
export interface ChatMessage extends Schema.Schema.Type<typeof ChatMessage> {}
export const PendingMessage = Schema.Struct({
  requestId: Schema.String,
  text: Schema.String,
  mode: Schema.Literals(['send', 'steer']),
  status: Schema.optionalKey(Schema.Literals(['sending', 'waiting', 'failed', 'discarded'])),
  date: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
})
export interface PendingMessage extends Schema.Schema.Type<typeof PendingMessage> {}
export const ClientCommand = Schema.TaggedUnion({
  StartChatGpt: {},
  PollChatGpt: { attemptId: Schema.String },
  CancelChatGpt: { attemptId: Schema.String },
  DisconnectChatGpt: {},
  Load: { afterId: Schema.optionalKey(Schema.Int) },
  SaveSettings: { settings: Settings, apiKey: Schema.String },
  DiscoverModels: { baseUrl: Schema.NonEmptyString, apiKey: Schema.String },
  Send: { requestId: Schema.NonEmptyString, text: Schema.NonEmptyString },
  Steer: {
    requestId: Schema.NonEmptyString,
    text: Schema.NonEmptyString,
    turnId: Schema.NonEmptyString,
  },
  Stop: { turnId: Schema.optionalKey(Schema.String) },
})
export type ClientCommand = typeof ClientCommand.Type
export const ServerEvent = Schema.TaggedUnion({
  ChatGptAuthorization: { authorization: DeviceAuthorization },
  ChatGptPending: { attemptId: Schema.String },
  ChatGptConnected: { settings: Settings },
  ChatGptCancelled: {},
  Connecting: {},
  Ready: { userId: Schema.String, streamId: Schema.optionalKey(Schema.String) },
  Snapshot: {
    settings: Schema.NullOr(Settings),
    hasApiKey: Schema.Boolean,
    messages: Schema.Array(ChatMessage),
    busy: Schema.Boolean,
    turnId: Schema.NullOr(Schema.String),
    pending: Schema.optionalKey(Schema.Array(PendingMessage)),
  },
  Models: { models: Schema.Array(ModelMapping) },
  Saved: {},
  Accepted: { requestId: Schema.String, mode: Schema.Literals(['send', 'steer']) },
  Message: { message: ChatMessage },
  Status: {
    busy: Schema.Boolean,
    turnId: Schema.NullOr(Schema.String),
    pending: Schema.Array(PendingMessage),
  },
  Discarded: { requestIds: Schema.Array(Schema.String), message: Schema.String },
  SettingsChanged: { settings: Settings },
  Heartbeat: {},
  Error: { message: Schema.String, requestId: Schema.optionalKey(Schema.String) },
})
export type ServerEvent = typeof ServerEvent.Type
export const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientCommand))
export const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerEvent))
