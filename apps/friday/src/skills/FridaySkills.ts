/* oxlint-disable effecttsgo/node-builtin-import -- Skill paths are synchronous configuration values. */

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { join } from 'node:path'

import { FRIDAY_SKILLS_DIRECTORY } from '../FridayHome.ts'
import fridayCliContent from './friday-cli/SKILL.md' with { type: 'text' }
import fridayDocumentContent from './friday-document/SKILL.md' with { type: 'text' }
import fridayUpdateContent from './friday-update/SKILL.md' with { type: 'text' }

export const FridaySkillAudience = Schema.Literals(['user', 'agent'])
export type FridaySkillAudience = typeof FridaySkillAudience.Type

const FridaySkills = [
  {
    name: 'friday-cli',
    content: fridayCliContent,
    audiences: ['user'],
  },
  {
    name: 'friday-document',
    content: fridayDocumentContent,
    audiences: ['user'],
  },
  {
    name: 'friday-update',
    content: fridayUpdateContent,
    audiences: ['user'],
  },
] as const satisfies ReadonlyArray<{
  readonly name: string
  readonly content: string
  readonly audiences: ReadonlyArray<FridaySkillAudience>
}>

export class FridaySkillError extends Schema.Error<FridaySkillError>('FridaySkillError')({
  _tag: Schema.tag('FridaySkillError'),
  skill: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const mapSkillError = (skill: string, operation: string) => (cause: unknown) =>
  new FridaySkillError({
    skill,
    detail: `Could not ${operation} Friday skill ${skill}: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  })

/** Installs every Friday-owned skill without rewriting unchanged files. */
export const ensureFridaySkills = (
  skillsDirectory: string = FRIDAY_SKILLS_DIRECTORY,
): Effect.Effect<void, FridaySkillError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    for (const skill of FridaySkills) {
      const skillDirectory = join(skillsDirectory, skill.name)
      const skillPath = join(skillDirectory, 'SKILL.md')
      yield* fileSystem
        .makeDirectory(skillDirectory, { recursive: true })
        .pipe(Effect.mapError(mapSkillError(skill.name, 'prepare')))
      const current = yield* fileSystem.readFileString(skillPath).pipe(
        Effect.option,
        Effect.map((existing) => (Option.isSome(existing) ? existing.value : null)),
      )
      if (current === skill.content) continue
      yield* fileSystem
        .writeFileString(skillPath, skill.content)
        .pipe(Effect.mapError(mapSkillError(skill.name, 'write')))
    }
  })

/** Returns installed Friday skill directories allowed for this session audience. */
export const fridaySkillPathsForAudience = (
  audience: FridaySkillAudience,
  skillsDirectory: string = FRIDAY_SKILLS_DIRECTORY,
): ReadonlyArray<string> =>
  FridaySkills.filter((skill) => skill.audiences.some((allowed) => allowed === audience)).map(
    (skill) => join(skillsDirectory, skill.name),
  )
