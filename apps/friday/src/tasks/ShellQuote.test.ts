/* oxlint-disable effecttsgo/node-builtin-import -- Shell round-trip verification shells out to /bin/sh. */
import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { quoteShellArgument } from './ShellQuote.ts'

const roundTrip = (branch: string): string =>
  execFileSync('/bin/sh', ['-c', `printf '%s' ${quoteShellArgument(branch)}`], {
    encoding: 'utf8',
  })

describe('quoteShellArgument', () => {
  it('quotes a conventional branch as one shell word', () => {
    expect(quoteShellArgument('feat/add-login')).toBe(`'feat/add-login'`)
    expect(roundTrip('feat/add-login')).toBe('feat/add-login')
  })

  it('keeps a semicolon branch as one argument', () => {
    expect(quoteShellArgument('fix/foo;bar')).toBe(`'fix/foo;bar'`)
    expect(roundTrip('fix/foo;bar')).toBe('fix/foo;bar')
  })

  it('keeps dollar, backtick, and quote characters literal', () => {
    for (const branch of ['fix/$money', 'fix/foo`bar`', `fix/o'clock`, 'fix/foo"bar']) {
      expect(roundTrip(branch)).toBe(branch)
    }
    expect(quoteShellArgument(`fix/o'clock`)).toBe(`'fix/o'\\''clock'`)
  })

  it('keeps ampersand, pipe, brackets, and spaces as one argument', () => {
    for (const branch of ['fix/foo&bar', 'fix/foo|bar', 'fix/foo<bar>', 'fix/foo bar']) {
      expect(roundTrip(branch)).toBe(branch)
    }
  })
})
