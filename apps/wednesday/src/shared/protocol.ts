import { ToolActivity, ResponsePhase } from './Activity.ts'
import { Schema } from 'effect'
import { Attachment, maxAttachments } from './Attachments.ts'

export const Thinking = Schema.Literals(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export type Thinking = typeof Thinking.Type
export const ApiFormat = Schema.Literals(['chat-completions', 'responses', 'anthropic'])
export type ApiFormat = typeof ApiFormat.Type
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
  apiFormat: Schema.optionalKey(ApiFormat),
  provider: Schema.optionalKey(Schema.Literals(['api', 'chatgpt'])),
  baseUrl: Schema.NonEmptyString,
  modelId: Schema.String,
  thinking: Thinking,
  models: Schema.Array(ModelMapping),
  memoryModelId: Schema.optionalKey(Schema.String),
  memoryThinking: Schema.optionalKey(Thinking),
})
export interface Settings extends Schema.Schema.Type<typeof Settings> {}
export const MessageReply = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  kind: Schema.Literals(['user', 'talk']),
  text: Schema.String,
})
export interface MessageReply extends Schema.Schema.Type<typeof MessageReply> {}
export const ChatMessage = Schema.Struct({
  activity: Schema.optionalKey(ToolActivity),
  id: Schema.Int,
  requestId: Schema.optionalKey(Schema.String),
  reply: Schema.optionalKey(MessageReply),
  attachments: Schema.optionalKey(
    Schema.Array(Attachment).check(Schema.isMaxLength(maxAttachments)),
  ),
  kind: Schema.Literals(['user', 'talk', 'tool', 'echo']),
  streamId: Schema.optionalKey(Schema.String),
  text: Schema.String,
  date: Schema.String,
})
export interface ChatMessage extends Schema.Schema.Type<typeof ChatMessage> {}
export const StreamingMessage = Schema.Struct({
  id: Schema.String,
  turnId: Schema.String,
  text: Schema.String,
  date: Schema.String,
})
export interface StreamingMessage extends Schema.Schema.Type<typeof StreamingMessage> {}
export const PendingMessage = Schema.Struct({
  reply: Schema.optionalKey(MessageReply),
  attachments: Schema.optionalKey(
    Schema.Array(Attachment).check(Schema.isMaxLength(maxAttachments)),
  ),
  requestId: Schema.String,
  text: Schema.String,
  mode: Schema.Literals(['send', 'steer']),
  status: Schema.optionalKey(
    Schema.Literals(['sending', 'waiting', 'failed', 'discarded', 'cancelled']),
  ),
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
  LoadOlder: { beforeId: Schema.Int },
  SaveSettings: { settings: Settings, apiKey: Schema.String },
  DiscoverModels: {
    baseUrl: Schema.NonEmptyString,
    apiKey: Schema.String,
    apiFormat: Schema.optionalKey(ApiFormat),
  },
  Send: {
    requestId: Schema.NonEmptyString,
    text: Schema.NonEmptyString,
    replyTo: Schema.optionalKey(Schema.Int),
    attachmentIds: Schema.optionalKey(
      Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(maxAttachments)),
    ),
  },
  Steer: {
    replyTo: Schema.optionalKey(Schema.Int),
    attachmentIds: Schema.optionalKey(
      Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(maxAttachments)),
    ),
    requestId: Schema.NonEmptyString,
    text: Schema.NonEmptyString,
    turnId: Schema.NonEmptyString,
  },
  Stop: { turnId: Schema.optionalKey(Schema.String) },
})
export type ClientCommand = typeof ClientCommand.Type
export const MemoryStatus = Schema.Literals(['idle', 'updating', 'preparing'])

export const ServerEvent = Schema.TaggedUnion({
  ChatGptAuthorization: { authorization: DeviceAuthorization },
  ChatGptPending: { attemptId: Schema.String },
  ChatGptConnected: { settings: Settings },
  ChatGptCancelled: {},
  Connecting: {},
  Ready: { userId: Schema.String, streamId: Schema.optionalKey(Schema.String) },
  MemoryStatus: { status: MemoryStatus },
  ResponsePhase: { turnId: Schema.String, phase: ResponsePhase },
  Snapshot: {
    memoryStatus: Schema.optionalKey(MemoryStatus),
    responsePhase: Schema.optionalKey(ResponsePhase),
    settings: Schema.NullOr(Settings),
    hasApiKey: Schema.Boolean,
    hasOlder: Schema.optionalKey(Schema.Boolean),
    streaming: Schema.optionalKey(Schema.NullOr(StreamingMessage)),
    messages: Schema.Array(ChatMessage),
    busy: Schema.Boolean,
    turnId: Schema.NullOr(Schema.String),
    pending: Schema.optionalKey(Schema.Array(PendingMessage)),
  },
  History: { messages: Schema.Array(ChatMessage), hasOlder: Schema.Boolean },
  Models: { models: Schema.Array(ModelMapping) },
  Saved: {},
  Accepted: { requestId: Schema.String, mode: Schema.Literals(['send', 'steer']) },
  Message: { message: ChatMessage, completesStreaming: Schema.optionalKey(Schema.Boolean) },
  Streaming: { message: Schema.NullOr(StreamingMessage) },
  Status: {
    busy: Schema.Boolean,
    turnId: Schema.NullOr(Schema.String),
    pending: Schema.Array(PendingMessage),
  },
  Discarded: {
    requestIds: Schema.Array(Schema.String),
    message: Schema.String,
    reason: Schema.optionalKey(Schema.Literals(['stopped', 'ended'])),
  },
  SettingsChanged: { settings: Settings },
  Heartbeat: {},
  Error: { message: Schema.String, requestId: Schema.optionalKey(Schema.String) },
})
export type ServerEvent = typeof ServerEvent.Type
export const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientCommand))
export const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerEvent))
