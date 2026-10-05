/* oxlint-disable effect-local/no-manual-effect-runtime-in-tests, effecttsgo/node-builtin-import -- Resource integration tests resolve Pi files only inside a temporary directory. */
import { test, expect } from 'bun:test'
import * as Effect from 'effect/Effect'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildResourcePrompt, loadPiResources } from './Resources.ts'

// Exercise upstream discovery and prompt rendering together, including precedence and hidden skills.
test('resolves global and project resources with Pi precedence and prompt formatting', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'friday-pi-resources-'))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        )
        const agentDir = join(directory, 'agent')
        const parent = join(directory, 'project')
        const cwd = join(parent, 'nested')
        const skillDir = join(cwd, '.pi', 'skills', 'inspect')
        const hiddenDir = join(cwd, '.pi', 'skills', 'hidden')
        yield* Effect.promise(() =>
          Promise.all([
            mkdir(agentDir, { recursive: true }),
            mkdir(skillDir, { recursive: true }),
            mkdir(hiddenDir, { recursive: true }),
          ]),
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(join(agentDir, 'SYSTEM.md'), 'Global preamble'),
            writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'Global addendum'),
            writeFile(join(agentDir, 'AGENTS.md'), 'Global instructions'),
            writeFile(join(parent, 'AGENTS.md'), 'Parent instructions'),
            writeFile(join(cwd, 'AGENTS.md'), 'Shadowed local instructions'),
            writeFile(join(cwd, 'AGENTS.override.md'), 'Local override instructions'),
            writeFile(join(cwd, '.pi', 'SYSTEM.md'), 'Project preamble'),
            writeFile(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'Project addendum'),
            writeFile(
              join(skillDir, 'SKILL.md'),
              '---\nname: inspect\ndescription: Inspect <code> & files.\n---\nInstructions',
            ),
            writeFile(
              join(hiddenDir, 'SKILL.md'),
              '---\nname: hidden\ndescription: Hidden sentinel.\ndisable-model-invocation: true\n---\nInstructions',
            ),
          ]),
        )
        const resources = yield* loadPiResources({ cwd, agentDir })
        const prompt = yield* buildResourcePrompt(resources, {
          cwd,
          selectedTools: ['read'],
          fallbackPrompt: 'Fallback',
          sections: { friday: 'Friday policy' },
        })
        expect(
          prompt.startsWith('Project preamble\n\n<addendum>\nProject addendum\n</addendum>'),
        ).toBe(true)
        expect(prompt).not.toContain('Global preamble')
        expect(prompt).not.toContain('Global addendum')
        expect(prompt).not.toContain('Shadowed local instructions')
        expect(prompt).toContain(
          `<project_instructions path="${join(cwd, 'AGENTS.override.md')}">\nLocal override instructions\n</project_instructions>`,
        )
        expect(prompt.indexOf('Global instructions')).toBeLessThan(
          prompt.indexOf('Parent instructions'),
        )
        expect(prompt.indexOf('Parent instructions')).toBeLessThan(
          prompt.indexOf('Local override instructions'),
        )
        expect(prompt).toContain('Inspect &lt;code&gt; &amp; files.')
        expect(prompt).toContain(`<location>${join(skillDir, 'SKILL.md')}</location>`)
        expect(prompt).not.toContain('Hidden sentinel')
        expect(prompt.indexOf('<project_context>')).toBeLessThan(prompt.indexOf('<skills>'))
        expect(prompt).toContain(`<cwd>\n${cwd}\n</cwd>\n\n<friday>\nFriday policy\n</friday>`)
        const bashPrompt = yield* buildResourcePrompt(resources, {
          cwd,
          selectedTools: ['bash'],
          fallbackPrompt: 'Fallback',
        })
        expect(bashPrompt).toContain('Use bash to load')
        const noReadPrompt = yield* buildResourcePrompt(resources, {
          cwd,
          selectedTools: [],
          fallbackPrompt: 'Fallback',
        })
        expect(noReadPrompt).not.toContain('<skills>')
      }),
    ),
  ))
