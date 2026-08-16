/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/process-env -- Temporary pre-configuration global path intentionally reads the process environment synchronously. */

import { homedir } from 'node:os'
import { resolve } from 'node:path'

const defaultFridayHome =
  process.env.NODE_ENV === 'development'
    ? resolve(process.cwd(), '.friday')
    : resolve(homedir(), '.friday')

export const FRIDAY_HOME = resolve(process.env.FRIDAY_HOME ?? defaultFridayHome)
