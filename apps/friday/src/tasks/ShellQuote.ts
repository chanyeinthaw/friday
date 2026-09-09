/**
 * Quote one value as a single POSIX shell word.
 *
 * Always single-quotes so every schema-accepted and Git-valid branch name
 * survives shell parsing as exactly one argument, including `; $ ` " & | < >`
 * and spaces (Git later rejects invalid ref names). A single quote inside the
 * value closes the quote, emits an escaped quote, and reopens it.
 */
export function quoteShellArgument(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
