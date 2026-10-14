import { Schema } from 'effect'

declare const FRIDAY_BUILD_ID: string
export const buildId = FRIDAY_BUILD_ID
export const BuildInfo = Schema.Struct({ id: Schema.NonEmptyString })
