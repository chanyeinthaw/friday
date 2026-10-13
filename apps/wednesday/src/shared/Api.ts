import { Context, Schema } from 'effect'
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from 'effect/http-api'
import { Settings, ServerEvent, ApiFormat } from './protocol.ts'
import { WednesdayError } from '../server/errors.ts'

export class CurrentUser extends Context.Service<
  CurrentUser,
  { readonly userId: string; readonly expiresAt: number }
>()('@wednesday/CurrentUser') {}
export class Unauthorized extends Schema.Error<Unauthorized>('Unauthorized')({
  _tag: Schema.tag('Unauthorized'),
  message: Schema.String,
}) {}
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentUser }
>()('@wednesday/Authentication', {
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized.annotate({ httpApiStatus: 401 }),
}) {}
const Submission = Schema.Struct({ requestId: Schema.NonEmptyString, text: Schema.NonEmptyString })
const Replies = Schema.Array(ServerEvent)
const error = WednesdayError.annotate({ httpApiStatus: 400 })
const ChatApi = HttpApiGroup.make('chat')
  .add(
    HttpApiEndpoint.post('startChatGpt', '/api/chatgpt/start', { success: Replies, error }),
    HttpApiEndpoint.post('pollChatGpt', '/api/chatgpt/poll', {
      payload: Schema.Struct({ attemptId: Schema.String }),
      success: Replies,
      error,
    }),
    HttpApiEndpoint.post('cancelChatGpt', '/api/chatgpt/cancel', {
      payload: Schema.Struct({ attemptId: Schema.String }),
      success: Replies,
      error,
    }),
    HttpApiEndpoint.post('disconnectChatGpt', '/api/chatgpt/disconnect', {
      success: Replies,
      error,
    }),
    HttpApiEndpoint.get('conversation', '/api/chat', { success: Replies, error }),
    HttpApiEndpoint.get('history', '/api/chat/history', {
      query: Schema.Struct({
        beforeId: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      }),
      success: Replies,
      error,
    }),
    HttpApiEndpoint.get('events', '/api/chat/events', {
      query: Schema.Struct({
        afterId: Schema.optionalKey(
          Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(-1)),
        ),
      }),
      success: HttpApiSchema.StreamSse({ data: ServerEvent }),
      error,
    }),
    HttpApiEndpoint.post('send', '/api/chat/messages', {
      payload: Submission,
      success: Replies,
      error,
    }),
    HttpApiEndpoint.post('steer', '/api/chat/steering', {
      payload: Schema.Struct({ ...Submission.fields, turnId: Schema.NonEmptyString }),
      success: Replies,
      error,
    }),
    HttpApiEndpoint.post('renewEvents', '/api/chat/events/renew', {
      payload: Schema.Struct({ streamId: Schema.NonEmptyString }),
      success: Schema.Struct({}),
      error,
    }),
    HttpApiEndpoint.post('stop', '/api/chat/stop', {
      payload: Schema.Struct({ turnId: Schema.optionalKey(Schema.String) }),
      success: Replies,
      error,
    }),
    HttpApiEndpoint.post('saveSettings', '/api/settings', {
      payload: Schema.Struct({ settings: Settings, apiKey: Schema.String }),
      success: Replies,
      error,
    }),
    HttpApiEndpoint.post('discoverModels', '/api/models', {
      payload: Schema.Struct({
        baseUrl: Schema.NonEmptyString,
        apiKey: Schema.String,
        apiFormat: Schema.optionalKey(ApiFormat),
      }),
      success: Replies,
      error,
    }),
  )
  .middleware(Authentication)
export const Api = HttpApi.make('Wednesday')
  .add(ChatApi)
  .add(
    HttpApiGroup.make('public').add(
      HttpApiEndpoint.get('config', '/config', {
        success: Schema.Struct({ publishableKey: Schema.NonEmptyString }),
      }),
    ),
  )
