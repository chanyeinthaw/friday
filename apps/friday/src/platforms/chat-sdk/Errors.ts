/* oxlint-disable eslint/no-underscore-dangle -- Effect schema errors use the canonical _tag discriminator. */

import * as Schema from 'effect/Schema'

export class ChatSdkLifecycleError extends Schema.Error<ChatSdkLifecycleError>(
  'ChatSdkLifecycleError',
)({
  _tag: Schema.tag('ChatSdkLifecycleError'),
  operation: Schema.Literals([
    'initialize',
    'shutdown',
    'gateway',
    'register-handlers',
    'create-adapter',
    'create-chat',
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Chat SDK ${this.operation} failed`
  }
}

export class ChatSdkCallbackError extends Schema.Error<ChatSdkCallbackError>(
  'ChatSdkCallbackError',
)({
  _tag: Schema.tag('ChatSdkCallbackError'),
  operation: Schema.Literals(['inbound-message', 'slash-command']),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return 'Chat SDK inbound message callback failed'
  }
}

export class ChatSdkPublicationError extends Schema.Error<ChatSdkPublicationError>(
  'ChatSdkPublicationError',
)({
  _tag: Schema.tag('ChatSdkPublicationError'),
  operation: Schema.Literals([
    'publish',
    'acknowledge',
    'begin-working',
    'update-working',
    'finalize-working',
    'discard-working',
    'set-conversation-title',
    'set-agent-activity',
    'set-thread-activity-title',
    'lookup-channel',
    'set-application-description',
  ]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return 'Chat SDK publication failed'
  }
}
