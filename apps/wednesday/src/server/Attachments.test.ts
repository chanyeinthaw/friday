import { describe, expect } from 'vitest'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { Base64 } from 'effect/encoding'
import { validateAttachment, attachmentPath } from './Attachments.ts'
import { makeAttachmentBash } from './AttachmentBash.ts'

describe('attachment workspace', () => {
  it.effect(
    'reads originals, keeps scratch between calls, and cannot modify attachments or reach the host',
    () =>
      Effect.gen(function* () {
        const file = yield* validateAttachment({
          name: '../../notes.md',
          mediaType: 'text/markdown',
          data: Base64.encode('# Title\nhello world\n'),
        })
        expect(file.name).toBe('notes.md')
        const run = makeAttachmentBash(Effect.succeed([file]), () =>
          Effect.succeed(Buffer.from(file.data, 'base64')),
        )
        const path = attachmentPath(file)
        expect(yield* run(`cat '${path}' | sed -n '2p'`)).toContain('hello world')
        expect(
          yield* run(`cp '${path}' /tmp/copy; echo changed >> /tmp/copy; cat /tmp/copy`),
        ).toContain('changed')
        expect(yield* run('cat /tmp/copy')).toContain('changed')
        expect(yield* run(`echo overwritten > '${path}'`)).toContain('read-only')
        expect(yield* run(`rm '${path}'`)).toContain('read-only')
        expect(yield* run(`mv '${path}' /tmp/stolen`)).toContain('read-only')
        expect(yield* run(`cat '${path}'`)).toContain('hello world')
        expect(yield* run('cat /etc/passwd')).not.toContain('root:')
        for (const command of [
          'curl https://example.com',
          'python3 -c pass',
          'js-exec 1',
          'sqlite3 :memory:',
          'ln -s /attachments /tmp/link',
        ])
          expect(yield* run(command)).toMatch(/command not (found|available)/)
        const otherUser = makeAttachmentBash(Effect.succeed([]), () =>
          Effect.succeed(new Uint8Array()),
        )
        expect(yield* otherUser(`cat '${path}'`)).not.toContain('hello world')
        expect(yield* otherUser('cat /tmp/copy')).not.toContain('changed')
      }),
  )
  it.effect('refreshes attachments for steering and bounds runaway commands', () =>
    Effect.gen(function* () {
      const file = yield* validateAttachment({
        name: 'note.txt',
        mediaType: 'text/plain',
        data: Base64.encode('later attachment'),
      })
      let files: readonly (typeof file)[] = []
      const run = makeAttachmentBash(
        Effect.sync(() => files),
        () => Effect.succeed(Buffer.from(file.data, 'base64')),
      )
      expect(yield* run('ls /attachments')).not.toContain(file.id)
      files = [file]
      expect(yield* run(`cat '${attachmentPath(file)}'`)).toContain('later attachment')
      expect(yield* run('while true; do :; done')).toMatch(/limit|exceeded/i)
    }),
  )
  it.effect('rejects unsupported or malformed content and detects image type from bytes', () =>
    Effect.gen(function* () {
      for (const input of [
        { name: 'note.txt', mediaType: 'text/plain', data: 'garbage' },
        {
          name: 'note.txt',
          mediaType: 'text/plain',
          data: Base64.encode(new Uint8Array([0, 255])),
        },
        { name: 'fake.png', mediaType: 'image/png', data: Base64.encode('not an image') },
        { name: 'app.exe', mediaType: '', data: Base64.encode('executable') },
      ])
        expect((yield* Effect.result(validateAttachment(input)))._tag).toBe('Failure')
      const image = yield* validateAttachment({
        name: 'photo.png',
        mediaType: '',
        data: Base64.encode(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
      })
      expect(image.mediaType).toBe('image/png')
    }),
  )
})
