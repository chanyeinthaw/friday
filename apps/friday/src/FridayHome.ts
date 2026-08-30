/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env -- Temporary pre-configuration global path intentionally reads the process environment synchronously. */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const defaultFridayHome =
  process.env.NODE_ENV === 'development'
    ? resolve(process.cwd(), '.friday')
    : resolve(homedir(), '.friday')

export const FRIDAY_HOME = resolve(process.env.FRIDAY_HOME ?? defaultFridayHome)
export const FRIDAY_LOG_DIRECTORY = join(FRIDAY_HOME, 'logs')
export const FRIDAY_LOG_PATH = join(FRIDAY_LOG_DIRECTORY, 'friday.jsonl')
export const FRIDAY_BIN_DIRECTORY = join(FRIDAY_HOME, 'bin')
export const FRIDAY_CLI_PATH = join(FRIDAY_BIN_DIRECTORY, 'friday')
