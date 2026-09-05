/* oxlint-disable effecttsgo/global-timers, effecttsgo/node-builtin-import, effecttsgo/process-env -- This executable fixture intentionally uses raw process IO. */

import { writeFile } from 'node:fs/promises'

const mode = process.argv[2]

switch (mode) {
  case 'failure': {
    process.stdout.write(' fixture stdout\n')
    process.stderr.write(' fixture failure\n')
    process.exitCode = 7
    break
  }
  case 'env-stdin': {
    process.stdin.setEncoding('utf8')
    let input = ''
    process.stdin.on('data', (chunk: string) => {
      input += chunk
    })
    process.stdin.on('end', () => {
      process.stdout.write(
        `${process.env.FRDAY_PROCESS_TEST ?? ''}:${process.env.GIT_TERMINAL_PROMPT ?? ''}:${input}`,
      )
    })
    break
  }
  case 'volume': {
    const bytes = 512 * 1024
    process.stdout.write('x'.repeat(bytes))
    process.stderr.write('y'.repeat(bytes))
    break
  }
  case 'wait': {
    const pidFile = process.argv[3]
    if (pidFile === undefined) throw new Error('missing pid file')
    await writeFile(pidFile, String(process.pid), 'utf8')
    setInterval(() => undefined, 1_000)
    break
  }
  default: {
    process.stderr.write(`unknown mode: ${mode ?? ''}`)
    process.exitCode = 2
  }
}
