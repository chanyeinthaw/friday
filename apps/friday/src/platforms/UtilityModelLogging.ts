/* oxlint-disable eslint/no-underscore-dangle -- Effect schema errors use the canonical _tag discriminator. */

import type { ModelId, ProviderId, ThinkingLevel } from '@friday/contracts/conversation'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/** Current utility model identity read from the configuration snapshot. */
export interface UtilityModelSnapshot {
  readonly provider: ProviderId
  readonly modelId: ModelId
  readonly thinkingLevel: ThinkingLevel
}

/** Minimal shape shared by utility-model domain errors. */
export interface UtilityDomainError {
  readonly _tag: string
  readonly operation: string
  readonly detail: string
  readonly cause?: unknown
}

/** Structured annotations for utility-model failure logs. */
export interface UtilityFailureAnnotations {
  readonly errorTag: string
  readonly operation: string
  readonly detail: string
  readonly cause?: string
  readonly utilityProvider?: ProviderId
  readonly utilityModelId?: ModelId
  readonly utilityThinkingLevel?: ThinkingLevel
}

/** Safe diagnostic fields accepted from an underlying defect. */
const SafeCauseDetail = Schema.Struct({
  code: Schema.optional(Schema.String),
  errno: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
  message: Schema.optional(Schema.String),
})
const decodeSafeCauseDetail = Schema.decodeUnknownOption(SafeCauseDetail)
const isStringCause = Schema.is(Schema.String)

const safeText = (value: string): string =>
  value
    .replaceAll(/[\r\n\t]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 500)

/**
 * Renders only an actionable, single-line message from an underlying
 * cause/defect. Stacks, tokens, and arbitrary request content are never
 * included; empty or uninformative causes return undefined.
 */
export const formatUtilityCause = (cause: unknown): string | undefined => {
  if (cause === undefined || cause === null) return undefined
  if (cause instanceof Error) {
    const text = safeText(cause.message)
    return text.length === 0 ? undefined : text
  }
  if (isStringCause(cause)) {
    const text = safeText(cause)
    return text.length === 0 ? undefined : text
  }
  const decoded = decodeSafeCauseDetail(cause)
  if (Option.isNone(decoded)) return undefined
  const detail = decoded.value
  const parts: Array<string> = []
  if (detail.code !== undefined) {
    const codeText = safeText(detail.code)
    if (codeText.length > 0) parts.push(`code=${codeText}`)
  }
  if (detail.errno !== undefined) {
    parts.push(`errno=${String(detail.errno)}`)
  }
  if (detail.message !== undefined) {
    const messageText = safeText(detail.message)
    if (messageText.length > 0) parts.push(messageText)
  }
  if (parts.length === 0) return undefined
  return parts.join(', ')
}

/**
 * Builds log annotations for a utility-model failure. Includes the domain
 * error identity (`errorTag`/`operation`/`detail`), the safely rendered
 * underlying cause where available, and the selected utility provider, model
 * ID, and thinking level where available. Callers preserve their own
 * component/thread/channel annotations alongside this shape.
 */
export const utilityFailureAnnotations = (
  error: UtilityDomainError,
  utility: UtilityModelSnapshot | undefined,
): UtilityFailureAnnotations => {
  const causeMessage = formatUtilityCause(error.cause)
  if (utility === undefined) {
    if (causeMessage === undefined) {
      return { errorTag: error._tag, operation: error.operation, detail: error.detail }
    }
    return {
      errorTag: error._tag,
      operation: error.operation,
      detail: error.detail,
      cause: causeMessage,
    }
  }
  if (causeMessage === undefined) {
    return {
      errorTag: error._tag,
      operation: error.operation,
      detail: error.detail,
      utilityProvider: utility.provider,
      utilityModelId: utility.modelId,
      utilityThinkingLevel: utility.thinkingLevel,
    }
  }
  return {
    errorTag: error._tag,
    operation: error.operation,
    detail: error.detail,
    cause: causeMessage,
    utilityProvider: utility.provider,
    utilityModelId: utility.modelId,
    utilityThinkingLevel: utility.thinkingLevel,
  }
}
