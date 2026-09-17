# 05. Maintainability and testing

## Code quality baseline

The codebase is unusually disciplined for its size:

- No explicit production `any` types were found.
- No production `JSON.parse` calls were found.
- Boundary payloads use schema decoders.
- Typed errors are defined with `Schema.Error`.
- Comments usually explain ordering, lifecycle, or safety decisions rather than restating code.
- The production import graph is acyclic.
- Test code is larger than production code, 31,471 versus 25,344 lines.

Type checking and all normal repository tests passed during the audit. Lint passed with a large
warning backlog. Many warnings are in tests or are known Effect boundary exceptions, but the volume
reduces the value of a clean lint run.

## Finding M1: the CLI is the main maintainability bottleneck

Severity: medium
Claim: observed

[`Cli.ts`](../../apps/friday/src/Cli.ts) is 4,080 lines. It owns:

- the command action union;
- argument parsing and validation;
- help tree definitions;
- text and JSON presentation;
- the 59-operation dependency contract;
- action classification;
- command execution and reload behavior;
- the embedded application version.

[`main.ts`](../../apps/friday/src/main.ts) then constructs the full operation object by manually
wiring each service call. The type system protects exhaustiveness, but adding one command still
touches a broad module and often the composition root.

### Recommendation

Split by command family while retaining one typed root registry:

```text
cli/
  Cli.ts                  root parse and dispatch
  Command.ts              shared spec and errors
  model.ts
  identity.ts
  discord.ts
  slack.ts
  worktree.ts
  workspace.ts
  document.ts
```

Each family should export its action schema, command tree, renderer, and handler contract. The root
combines them and checks action exhaustiveness. Do not introduce a plugin system or reflection.

## Finding M2: platform composition has high fan-out

Severity: medium
Claim: observed

Discord and Slack live modules have the highest local import fan-out after the composition roots.
Their callback literals combine several policies and lifecycle concerns. See
[platform architecture](03-platforms.md) for the suggested connection builders.

## Finding M3: selected quality gates are strong, repository-wide gates are incomplete

Severity: medium
Claim: observed

The test suite covers concurrency, SQLite integration, socket lifecycle, worktree locking, platform
admission, routing, steering, task ownership, and configuration. Mutation testing targets access
policy, task policy, Discord configuration, connections, worktrees, cleanup, CLI, and prompts, with
high thresholds on the most security-sensitive pure logic.

Gaps:

- No pull-request or `main` workflow runs `pnpm verify` in the repository.
- Mutation suites are opt-in and do not run in the release workflow.
- There is no repository-wide coverage policy, which is acceptable, but delivery recovery and
  restart reconciliation lack focused end-to-end tests.
- One live Pi test is intentionally separate from the normal test command.

### Recommendation

Add a CI workflow for pull requests and pushes to `main` that runs `pnpm verify`. Keep mutation tests
scheduled or manually dispatched because they are expensive. Add focused tests for:

1. terminal turn persisted, first publish fails, retry later succeeds;
2. process starts with a `running` turn and reconciles it;
3. inbound callback resolves after durable acceptance while terminal work continues;
4. shutdown interrupts or drains application-owned background work.

## Finding M4: lint warnings have become background noise

Severity: low
Claim: observed

`pnpm lint` exits successfully but emits hundreds of warnings across source, tests, and release
scripts. Some are intentional SDK boundary assertions. Others flag mutable array operations,
shadowed names, raw async functions, broad test casts, and ignored Effect guidance.

### Recommendation

Do one warning-baseline pass:

- Fix simple production warnings.
- Move justified repeated exceptions into narrow file-level rules with explanations.
- Keep test-only unsafe assertions separate from production lint reporting if the tool supports it.
- Make new warnings fail CI without requiring the historical backlog to vanish at once.

## Finding M5: current architecture lacks a maintainer entry point

Severity: low
Claim: observed

The repository has detailed feature and research documents, but no root README and no current
architecture document. The research notes are useful, yet some describe a target state that has
since been implemented.

### Recommendation

Add a short root README that links to this audit, local commands, the runtime diagram, configuration
docs, and release process. Keep the README small. This report set can remain the detailed reference.

## Consistency exceptions

The project instructions prohibit direct `try...catch`, but production code contains a few local
uses at SDK and Promise boundaries. Replace catch-based decoding in platform wiring with an Option
or Effect decoder where practical. `try...finally` used solely for resource disposal is less
concerning, but scoped Effect acquisition is still the preferred form.
