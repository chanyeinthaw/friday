/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/node-builtin-import, effecttsgo/strict-effect-provide -- This suite exercises skill installation in an isolated temporary directory. */

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureFridaySkills, fridaySkillPathsForAudience } from './FridaySkills.ts'

describe('Friday skills', () => {
  it.effect('installs every skill idempotently and repairs drift', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-skills-')))
      const skillsDirectory = join(root, 'skills')
      const documentSkillPath = join(skillsDirectory, 'friday-document', 'SKILL.md')
      const read = (path: string) =>
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fileSystem) => fileSystem.readFileString(path)),
          Effect.provide(NodeFileSystem.layer),
        )
      const install = ensureFridaySkills(skillsDirectory).pipe(Effect.provide(NodeFileSystem.layer))
      yield* install
      const written = yield* read(documentSkillPath)
      assert.include(written, 'friday-document')
      assert.include(written, 'document save')
      assert.include(yield* read(join(skillsDirectory, 'friday-cli', 'SKILL.md')), 'Friday CLI')
      assert.include(
        yield* read(join(skillsDirectory, 'friday-update', 'SKILL.md')),
        'Update Friday',
      )
      yield* install
      assert.strictEqual(yield* read(documentSkillPath), written)
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) => fileSystem.writeFileString(documentSkillPath, 'drifted')),
        Effect.provide(NodeFileSystem.layer),
      )
      yield* install
      assert.strictEqual(yield* read(documentSkillPath), written)
    }),
  )

  it('discloses safe operational skills by audience', () => {
    const userSkills = fridaySkillPathsForAudience('user')
    const agentSkills = fridaySkillPathsForAudience('agent')
    assert.strictEqual(userSkills.length, 3)
    assert.isTrue(userSkills.some((path) => path.endsWith('friday-document')))
    assert.isTrue(userSkills.some((path) => path.endsWith('friday-update')))
    assert.deepStrictEqual(agentSkills, [])
  })

  it.effect('routes reusable material to documents with a short chat summary', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-skills-docs-')))
      const skillsDirectory = join(root, 'skills')
      yield* ensureFridaySkills(skillsDirectory).pipe(Effect.provide(NodeFileSystem.layer))
      const written = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          fileSystem.readFileString(join(skillsDirectory, 'friday-document', 'SKILL.md')),
        ),
        Effect.provide(NodeFileSystem.layer),
      )
      assert.include(written, 'reports, guides, detailed investigations')
      assert.include(written, 'reusable reference')
      assert.include(written, 'short summary and the link')
      assert.include(written, 'ordinary discussion')
      assert.include(written, 'short explanations')
      assert.include(written, 'small code samples')
      assert.include(written, 'explicitly asks for chat or a document')
      assert.include(written, 'reuse the same key for updates')
      assert.include(written, 'readability')
      assert.include(written, 'document revoke')
      assert.include(written, '`get` and `list` never return URLs')
    }),
  )
})
