# Provide tools to Pi-durable

Friday supplies tool lists through `@friday/pi-durable-effect`.
The wrapper creates Pi's required named registrations internally.
Tool authors do not need extension files or an extension loader.

## Define a tool

Use the existing TypeBox parameter schema and return Pi content and JSON details from an Effect callback.

```ts
import { Type } from '@earendil-works/pi-ai'
import { defineEffectTool } from '@friday/pi-durable-effect'
import * as Effect from 'effect/Effect'

export const greet = defineEffectTool({
  name: 'greet',
  description: 'Return a greeting for a name.',
  parameters: Type.Object({ name: Type.String() }),
  replay: 'safe',
  execute: ({ name }) =>
    Effect.succeed({
      content: [{ type: 'text', text: `Hello, ${name}.` }],
      details: { name },
    }),
})
```

The callback receives inferred arguments, the native invocation API, and Pi's context.
The wrapper propagates Pi cancellation to the Effect and runs Effect finalizers.
Use `api.output` for streaming and `piOperation` around its Promise operations.
The invocation API expires when the callback returns.

Pass existing Effect service contracts into tool factories, as Friday's messages and task tools do.
For a callback that requires services from Effect context, capture `makePiRunner<MyService>()` during construction.
Run native `defineTool` callbacks through that runner while the service scope remains open.

## Supply the tool list

The wrapper exposes a registry and a provider that returns an agent loadout.
The following code runs inside a scoped Effect generator:

```ts
const tools = createToolRegistry()
const loadout = yield * tools.provide('my-agent', { tools: [greet] })
const harness = yield * openHarness(storage, { models, registry: tools.registry })
const conversation =
  yield *
  piOperation('create-conversation', (context) =>
    harness.root(context, { agent: { ...loadout, model } }),
  )
```

Keep the registration name stable across restart and register before scheduler recovery.
Calling `provide` again replaces that registration and refreshes its callbacks.
It also accepts an Effect `systemPrompt` callback and durable task definitions.

Friday constructs its list in `registerThread` in `apps/friday/src/harness/pi/PiDurable.ts`.
Add a tool to that list for the audiences that need it.
User threads receive coding tools, `messages`, and `task`.
Background threads receive coding tools.
Routing receives only `thread_route`, and title generation receives no tools.
No competing `subagent` tool is registered.

## Port existing tools

Replace `pi.registerTool` with `defineEffectTool` and keep its schema and business behavior.
Move the old callback's call ID, update, and cancellation handling to `api.callId`, `api.output`, and the Effect callback.
Return JSON-compatible details.
Remove extension factory and registration code, then add the tool to Friday's list.

Skills, `AGENTS.md`, `SYSTEM.md`, and `APPEND_SYSTEM.md` need no tool port.
See [Pi-durable integration](pi-durable.md) for resource resolution and prompt assembly.
Commands and terminal UI APIs belong in Friday's command and presentation code.

## Choose replay and persistent state

Set `replay: 'safe'` only if repeating an interrupted invocation is acceptable.
Read-only lookups usually qualify. External writes need idempotency before they qualify.
The default is `unsafe`. Friday's task tool remains unsafe because repeating a start can create another task.

An Effect retry or finalizer does not make a tool durable.
Use Pi documents and transactions for authoritative state.
Use versioned `defineTask` checkpoints for work that must resume after restart.
Keep network calls outside authoritative transactions.

Test decoding and business behavior, interruption, and the chosen replay policy.
Run `pnpm verify` after adding the tool.
External custom tool implementations have not been inventoried or ported.
