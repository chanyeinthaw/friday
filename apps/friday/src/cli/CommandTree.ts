import * as Effect from 'effect/Effect'

import { FridayCliError, type FridayCliAction } from './Types.ts'
import {
  isCliBranch,
  isCliRemoved,
  type CliBranchSpec,
  type CliCommandSpec,
  type CliLeafSpec,
} from './Command.ts'
import {
  missingSubcommandError,
  removedCommandError,
  unknownSubcommandError,
  parseStart,
} from './Parsing.ts'
import { configCommand } from './families/Config.ts'
import { documentCommand } from './families/Document.ts'
import { modelCommand } from './families/Model.ts'
import { workspaceCommand } from './families/Workspace.ts'
import { worktreeCommand } from './families/Worktree.ts'

const isLeaf = (node: CliCommandSpec): node is CliLeafSpec =>
  !isCliBranch(node) && !isCliRemoved(node)

const permissionPoliciesNote = `Permission policies are "all", "allow=<id>[,<id>...]", or "deny=<id>[,<id>...]".
Channel entries set with "guild channel set" are per-channel overrides of the
guild defaults. A channel "--users" policy replaces the guild user policy
completely; allow lists are not merged, so repeat any guild-allowed IDs you
still want to permit. Which channels admit Friday at all is controlled
separately by the guild channel scope ("guild set-channels"). Overrides never
grant admission. The default reply mode is reply-in-thread; channels already
inside a user-created thread always stay in that thread.`

/** Resolves the command node at a topic path, if the path names a live node. */
export const findCommandSpec = (path: ReadonlyArray<string>): CliCommandSpec | undefined => {
  let node: CliCommandSpec = cliCommandSpec
  for (const name of path) {
    if (!isCliBranch(node)) return undefined
    const child: CliCommandSpec | undefined = node.children.find(
      (candidate) => candidate.name === name,
    )
    if (child === undefined) return undefined
    node = child
  }
  return node
}

/** Resolves the deepest command prefix of the arguments as the help topic. */
const helpTopic = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const topic: string[] = []
  let node: CliCommandSpec = cliCommandSpec
  for (const argument of arguments_) {
    if (!isCliBranch(node)) break
    const child: CliCommandSpec | undefined = node.children.find(
      (candidate) => candidate.name === argument,
    )
    // Removed command forms are not help topics; help falls back to their parent.
    if (child === undefined || isCliRemoved(child)) break
    topic.push(child.name)
    node = child
  }
  return topic
}

const renderEntry = (path: ReadonlyArray<string>, leaf: CliLeafSpec): ReadonlyArray<string> => [
  `  ${path.join(' ')}${leaf.arguments?.[0] === undefined ? '' : ` ${leaf.arguments[0]}`}`,
  ...(leaf.arguments ?? []).slice(1).map((line) => `      ${line}`),
  `      ${leaf.summary}`,
]

const renderLeafEntries = (
  node: CliBranchSpec,
  path: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  node.children.flatMap((child): ReadonlyArray<string> => {
    if (isCliRemoved(child)) return []
    const childPath = [...path, child.name]
    return isCliBranch(child) ? renderLeafEntries(child, childPath) : renderEntry(childPath, child)
  })

const renderChildEntries = (node: CliBranchSpec): ReadonlyArray<string> =>
  node.children.flatMap((child): ReadonlyArray<string> => {
    if (isCliRemoved(child)) return []
    return isCliBranch(child)
      ? [`  ${child.name}`, `      ${child.summary}`]
      : renderEntry([child.name], child)
  })

/**
 * Renders help for one command topic: the full command listing for the empty
 * topic, child commands for a branch, or the exact usage for a leaf. Removed
 * forms and unknown topics fall back to the full listing.
 */
export const renderCliHelp = (topic: ReadonlyArray<string> = []): string => {
  const node = findCommandSpec(topic)
  if (node === undefined || isCliRemoved(node)) return renderCliHelp([])
  if (topic.length === 0) {
    return [
      'Friday — your personal agent',
      '',
      'Usage:',
      '  friday [command]',
      '',
      'Commands:',
      ...renderLeafEntries(cliCommandSpec, []),
      '',
      'Notes:',
      ...permissionPoliciesNote.split('\n').map((line) => `  ${line}`),
      '',
      'Options:',
      '  -h, --help     Show help; add a command prefix for help on that command',
      '  -v, --version  Show the version',
    ].join('\n')
  }
  if (isLeaf(node)) {
    return [
      node.summary,
      '',
      'Usage:',
      `  friday ${topic.join(' ')}${node.arguments?.[0] === undefined ? '' : ` ${node.arguments[0]}`}`,
      ...(node.arguments ?? []).slice(1).map((line) => `      ${line}`),
    ].join('\n')
  }
  return [node.summary, '', 'Commands:', ...renderChildEntries(node)].join('\n')
}

/** The complete Friday CLI command tree used by parsing, validation, and help. */
export const cliCommandSpec: CliBranchSpec = {
  name: 'friday',
  summary: 'Friday — your personal agent.',
  children: [
    {
      name: 'start',
      summary: 'Start Friday (the default when no command is given).',
      parse: parseStart,
    },
    configCommand,
    modelCommand,
    worktreeCommand,
    documentCommand,
    workspaceCommand,
  ],
}

/**
 * Walks the typed command tree: a matched child deepens the path, a branch
 * prefix without or with an unknown subcommand fails with the known child
 * list, a removed form fails with its replacement pointer, and a leaf parses
 * its own remaining tokens.
 */
const dispatchCommand = (
  path: ReadonlyArray<string>,
  node: CliCommandSpec,
  tokens: ReadonlyArray<string>,
  all: ReadonlyArray<string>,
): Effect.Effect<FridayCliAction, FridayCliError> => {
  if (isCliRemoved(node)) {
    return Effect.fail(removedCommandError(all, node.removed, node.replacement))
  }
  if (isLeaf(node)) return node.parse(tokens, all)
  const [head, ...rest] = tokens
  if (head === undefined) return Effect.fail(missingSubcommandError(path, node, all))
  const child = node.children.find((candidate) => candidate.name === head)
  if (child === undefined) return Effect.fail(unknownSubcommandError(path, head, node, all))
  return dispatchCommand([...path, child.name], child, rest, all)
}

export const parseFridayCli = (
  all: ReadonlyArray<string>,
): Effect.Effect<FridayCliAction, FridayCliError> => {
  const helpIndex = all.findIndex((argument) => argument === '-h' || argument === '--help')
  if (helpIndex >= 0) {
    return Effect.succeed({ type: 'help', topic: helpTopic(all.slice(0, helpIndex)) })
  }
  if (all.length === 1 && (all[0] === '--version' || all[0] === '-v')) {
    return Effect.succeed({ type: 'version' })
  }
  // With no arguments Friday starts; `start` is also a regular tree command.
  if (all.length === 0) return Effect.succeed({ type: 'start' })
  return dispatchCommand([], cliCommandSpec, all, all)
}
