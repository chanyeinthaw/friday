# Pi-durable for Effect

`@friday/pi-durable-effect` wraps Pi-durable 1.0.2 for Effect v4.
Friday consumes this workspace package for production execution and temporary utility harnesses.

## API

| Export                                                          | Behavior                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `openHarness(storage, options)`                                 | Acquires a native Pi harness and closes it when the Effect scope ends. Close failures become defects.                          |
| `piOperation(operation, callback)`                              | Runs a Pi Promise operation with the Effect abort signal and a typed `PiDurableError`.                                         |
| `defineEffectTool(tool)`                                        | Accepts an Effect `execute` callback with inferred TypeBox arguments and native Pi results. Invocations honor Pi cancellation. |
| `runPiEffect(effect, context)`                                  | Runs a fully provided Effect inside a Pi callback using its abort signal.                                                      |
| `makePiRunner<R>()`                                             | Captures Effect services during construction and returns a runner for Pi callbacks that require those services.                |
| `PiDurableError`                                                | Tagged boundary failure with `operation`, optional `detail`, and optional `cause`.                                             |
| `makePiSqliteStorage()` from `@friday/pi-durable-effect/sqlite` | Adapts an Effect `SqlClient` SQLite connection to Pi storage. Preserves transaction rollback error identity.                   |

The native harness retains Pi's document, transaction, task, conversation, and submission types.
Use `piOperation` for operations on those handles.
The package does not implement a second scheduler or persistence model.

## Scope and cancellation

Provide the SQLite layer outside the harness scope so the harness closes before its connection.
The SQL layer owns the connection. The adapter's `close` does not close that shared resource.
Use a dedicated SQLite database because Pi owns its tables.

Interrupting `piOperation` cancels the operation's wait.
An admitted submission continues under Pi's scheduler until explicitly aborted through the conversation API.
Pi cancellation interrupts `runPiEffect` and `defineEffectTool` callbacks and runs their Effect finalizers.
Cancellation does not undo an external side effect.

Build tools and capture their services within the same application lifetime as the harness.
A captured runner does not extend the lifetime of scoped services.
Use native `defineTool` with `makePiRunner` when a tool needs Effect services.
Use `defineEffectTool` when its dependencies are already provided or passed as service contracts.

See [Provide tools to Pi-durable](../../docs/pi-durable-tools.md) for examples and registration.

## Tools and resources

`createToolRegistry()` returns a native registry and `provide(name, options)`.
Supply a tool list, an optional Effect system prompt, and optional durable tasks.
The returned loadout configures a conversation. Pi extension objects stay inside the wrapper.
`codingTools` exports the native read, write, edit, and bash tools as a list.

The `@friday/pi-durable-effect/resources` entry exports `loadPiResources` and `buildResourcePrompt`.
Loading delegates to `DefaultResourceLoader` with JavaScript extensions and themes disabled.
Building delegates to Pi's original `buildSystemPrompt` with loaded resources and active tool names.
The workspace patch for pi-coding-agent 1.0.2 only exports this private function from the package entry point and its declarations.
Renderer and discovery code remain unmodified. Keep the patch synchronized when upgrading Pi.

## Verification

`pnpm verify` includes callback service-capture and interruption tests, Friday's harness integration tests, and Pi's 23 storage conformance cases.
All storage tests use temporary databases.
