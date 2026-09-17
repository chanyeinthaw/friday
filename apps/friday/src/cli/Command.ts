import * as Effect from 'effect/Effect'

import { FridayCliError, type FridayCliAction } from './Types.ts'

/**
 * One node of the CLI command tree: the typed source of parsing, validation,
 * and help. A branch lists its children, a leaf parses the tokens
 * after its own command path, and a removed node rejects an old command form
 * with a pointer to its replacement while staying out of help.
 */
export interface CliLeafSpec {
  readonly name: string
  readonly summary: string
  /** Usage fragments for a leaf command; fragments continue on wrapped lines. */
  readonly arguments?: ReadonlyArray<string>
  /**
   * Parses the tokens after the leaf's command path into a typed action.
   * `all` is the complete original argument list, for error reporting.
   */
  readonly parse: (
    tokens: ReadonlyArray<string>,
    all: ReadonlyArray<string>,
  ) => Effect.Effect<FridayCliAction, FridayCliError>
}

export interface CliBranchSpec {
  readonly name: string
  readonly summary: string
  readonly children: ReadonlyArray<CliCommandSpec>
}

export interface CliRemovedSpec {
  readonly name: string
  /** The removed command form, named in the rejection message. */
  readonly removed: string
  /** The replacement command form, named in the rejection message. */
  readonly replacement: string
}

export type CliCommandSpec = CliLeafSpec | CliBranchSpec | CliRemovedSpec

export const isCliBranch = (node: CliCommandSpec): node is CliBranchSpec => 'children' in node
export const isCliRemoved = (node: CliCommandSpec): node is CliRemovedSpec => 'removed' in node
