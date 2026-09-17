import * as Schema from 'effect/Schema'

export class TaskError extends Schema.Error<TaskError>('TaskError')({
  _tag: Schema.tag('TaskError'),
  operation: Schema.Literals([
    'start',
    'bootstrap',
    'steer',
    'list',
    'cancel',
    'inspect',
    'set-model',
  ]),
  reason: Schema.Literals([
    'model-not-configured',
    'invalid-working-directory',
    'channel-workspace',
    'outside-channel-workspace',
    'working-directory-busy',
    'task-not-found',
    'task-not-owned',
    'task-not-active',
    'parent-not-found',
    'parent-not-channel',
    'start-failed',
    'invalid-cursor',
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail
  }
}

export const taskError = (
  reason: TaskError['reason'],
  detail: string,
  operation: TaskError['operation'] = 'start',
) => new TaskError({ operation, reason, detail })
