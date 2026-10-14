import {
  Bash,
  InMemoryFs,
  MountableFs,
  type IFileSystem,
  type InitialFiles,
} from 'just-bash/browser'
import { Effect } from 'effect'
import { attachmentPath } from './Attachments.ts'
import type { Attachment } from '../shared/Attachments.ts'
import { failure, type WednesdayError } from './errors.ts'
import { clipToolOutput } from './MessageSizing.ts'

const denied = () => Promise.reject(new Error('EROFS: attachments are read-only'))
// Expose only the filesystem interface; do not leak InMemoryFs's synchronous mutation helpers.
const readOnly = (fs: InMemoryFs): IFileSystem => ({
  readFile: fs.readFile.bind(fs),
  readFileBytes: fs.readFileBytes.bind(fs),
  readFileBuffer: fs.readFileBuffer.bind(fs),
  exists: fs.exists.bind(fs),
  stat: fs.stat.bind(fs),
  lstat: fs.lstat.bind(fs),
  readdir: fs.readdir.bind(fs),
  readdirWithFileTypes: fs.readdirWithFileTypes.bind(fs),
  resolvePath: fs.resolvePath.bind(fs),
  getAllPaths: fs.getAllPaths.bind(fs),
  readlink: fs.readlink.bind(fs),
  realpath: fs.realpath.bind(fs),
  writeFile: denied,
  appendFile: denied,
  mkdir: denied,
  createExclusive: denied,
  rm: denied,
  cp: denied,
  mv: denied,
  chmod: denied,
  symlink: denied,
  link: denied,
  utimes: denied,
})

/** One private, host-free workspace per turn; refreshed mounts include new steering attachments. */
export const makeAttachmentBash = (
  files: Effect.Effect<readonly Attachment[], WednesdayError>,
  read: (file: Attachment) => Effect.Effect<Uint8Array, WednesdayError>,
) => {
  const scratch = new InMemoryFs({}, { maxTotalBytes: 32 * 1024 * 1024 })
  return Effect.fn('Attachments.bash')(function* (command: string) {
    const attachments = yield* files
    const initial: InitialFiles = Object.fromEntries(
      attachments.map((file) => [
        attachmentPath(file).slice('/attachments'.length),
        () => Effect.runPromise(read(file)),
      ]),
    )
    const fs = new MountableFs({
      base: readOnly(new InMemoryFs()),
      mounts: [
        { mountPoint: '/attachments', filesystem: readOnly(new InMemoryFs(initial)) },
        { mountPoint: '/tmp', filesystem: scratch },
      ],
    })
    const bash = new Bash({
      fs,
      cwd: '/tmp',
      python: false,
      javascript: false,
      commands: [
        'ls',
        'cat',
        'head',
        'tail',
        'rg',
        'grep',
        'sed',
        'awk',
        'jq',
        'wc',
        'sort',
        'uniq',
        'cut',
        'tr',
        'find',
        'pwd',
        'echo',
        'printf',
        'mkdir',
        'cp',
        'mv',
        'rm',
        'touch',
        'tee',
        'basename',
        'dirname',
        'diff',
        'file',
        'xargs',
      ],
      executionLimits: {
        maxSourceBytes: 16_384,
        maxCommandCount: 1000,
        maxLoopIterations: 10_000,
        maxAwkIterations: 10_000,
        maxSedIterations: 10_000,
        maxJqIterations: 10_000,
        maxExecutionTimeMs: 10_000,
        maxOutputSize: 64_000,
        maxStringLength: 16 * 1024 * 1024,
        maxInputBytes: 32 * 1024 * 1024,
        maxLiveBytes: 64 * 1024 * 1024,
        maxWorkUnits: 100_000,
        maxTraversalEntries: 10_000,
      },
    })
    const result = yield* Effect.tryPromise({
      try: (signal) => bash.exec(command, { signal }),
      catch: (error) =>
        failure(
          error instanceof Error
            ? error.message
            : 'The command could not finish within the workspace limits.',
        ),
    }).pipe(
      Effect.catch((error) => Effect.succeed({ stdout: '', stderr: error.message, exitCode: 1 })),
    )
    return clipToolOutput(
      `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}\n[exit ${result.exitCode}]`,
    )
  })
}
