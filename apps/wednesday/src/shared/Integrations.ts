import { Schema } from 'effect'

export const FirecrawlUsage = Schema.Struct({
  remainingCredits: Schema.Number,
  planCredits: Schema.Number,
  billingPeriodStart: Schema.NullOr(Schema.String),
  billingPeriodEnd: Schema.NullOr(Schema.String),
})
export interface FirecrawlUsage extends Schema.Schema.Type<typeof FirecrawlUsage> {}
export const FirecrawlStatus = Schema.Struct({
  connected: Schema.Boolean,
  usage: Schema.NullOr(FirecrawlUsage),
  usageError: Schema.optionalKey(Schema.String),
})
export interface FirecrawlStatus extends Schema.Schema.Type<typeof FirecrawlStatus> {}
export const FirecrawlConnection = Schema.Struct({
  apiKey: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
})
