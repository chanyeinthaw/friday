/* oxlint-disable eslint/no-underscore-dangle -- Effect schemas and schema issues use the canonical _tag discriminator. */

import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'

const summarizeSchemaIssue = (issue: SchemaIssue.Issue): string => {
  switch (issue._tag) {
    case 'Filter':
    case 'Encoding':
    case 'Pointer':
      return `${issue._tag}(${summarizeSchemaIssue(issue.issue)})`
    case 'Composite':
    case 'AnyOf':
      return `${issue._tag}(${issue.issues.map(summarizeSchemaIssue).join(',')})`
    default:
      return issue._tag
  }
}

export class PersistenceSqlError extends Schema.Error<PersistenceSqlError>('PersistenceSqlError')({
  _tag: Schema.tag('PersistenceSqlError'),
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail === undefined
      ? `SQL error in ${this.operation}`
      : `SQL error in ${this.operation}: ${this.detail}`
  }
}

export class PersistenceDecodeError extends Schema.Error<PersistenceDecodeError>(
  'PersistenceDecodeError',
)({
  _tag: Schema.tag('PersistenceDecodeError'),
  operation: Schema.String,
  issue: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  static fromSchemaError(operation: string, cause: Schema.SchemaError): PersistenceDecodeError {
    return new PersistenceDecodeError({
      operation,
      issue: summarizeSchemaIssue(cause.issue),
      cause,
    })
  }

  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`
  }
}

export type PersistenceError = PersistenceSqlError | PersistenceDecodeError
