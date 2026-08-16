# Effect patterns for Friday services, thread runtimes, and interface surfaces

## Question

How should Friday distinguish singleton Effect services from dynamically constructed per-Thread runtimes, and how should it support several simultaneous user-interface integrations such as Discord, Slack, Linear, and a future web interface?

## Findings

### 1. Singleton capabilities are context services provided by layers

Effect defines capabilities with `Context.Service` and provides concrete implementations with `Layer.succeed` or `Layer.effect`. Consumers obtain the capability with `yield* Service`; they do not need to call an exported constructor.

`Context.Service` explicitly describes the service key as a dependency supplied by the surrounding context. Its runtime string is the service identity. See [`node_modules/effect/src/Context.ts`](../../node_modules/effect/src/Context.ts), the `Service` documentation and implementation around lines 163–410.

Effect's EventLog registry is a concrete example of the target shape: `Registry` is a `Context.Service`, and `layerRegistry` constructs its mutable implementation directly with `Layer.effect(Registry, Effect.gen(...))`. There is no public `makeRegistry` required by consumers. See [`node_modules/effect/src/unstable/eventlog/EventLog.ts`](../../node_modules/effect/src/unstable/eventlog/EventLog.ts), around lines 70–180.

**Application to Friday:** define `Friday` as a service and provide `FridayLive` with `Layer.effect`. A public `makeFriday` is unnecessary. A private construction effect is acceptable only if it makes the layer implementation easier to read.

### 2. Factories are services when they create many runtime instances

Effect's `PersistedQueueFactory` is itself a singleton `Context.Service`, while each named `PersistedQueue` is a value created through that service. Effect also exports a convenience accessor that delegates to the factory. See [`node_modules/effect/src/unstable/persistence/PersistedQueue.ts`](../../node_modules/effect/src/unstable/persistence/PersistedQueue.ts), around lines 70–197.

**Application to Friday:** the harness-neutral runtime creator should be a service such as `ThreadRuntimes` or `ThreadRuntimeFactory`. It exposes `open(thread)`, returning one scoped `ThreadRuntime`. The Pi adapter may keep an internal `makePiThreadRuntime` because it constructs an actual per-Thread runtime instance.

### 3. `LayerMap` matches keyed, scoped per-Thread resources

Effect describes `LayerMap` as a cache of scoped services selected by key. It builds a resource on demand, shares concurrent acquisition for the same key, and supports invalidation and idle release. Its documented use cases include tenant clients, regional connections, and other keyed resource families. See [`node_modules/effect/src/LayerMap.ts`](../../node_modules/effect/src/LayerMap.ts), lines 1–190.

`LayerMap.Service` can expose the keyed resource family itself as a context service. See the same file around lines 266–438.

Underneath, `LayerMap` uses `RcMap`. Effect documents `RcMap` as a reference-counted map for clients, sessions, and connections—not as a general mutable cache. It acquires once per key, shares in-progress acquisition, and releases after the last scoped reference. See [`node_modules/effect/src/RcMap.ts`](../../node_modules/effect/src/RcMap.ts), lines 1–238.

**Application to Friday:** a Friday Thread ID is a natural key for a scoped `ThreadCoordinator`/`ThreadRuntime` resource. This is safer than the current unscoped JavaScript `Map<ThreadId, ThreadCoordinator>` because lifetime, concurrent acquisition, and cleanup become Effect-owned.

### 4. `FiberMap` matches keyed background work, not resource lookup

Effect documents `FiberMap` as a scoped collection of fibers indexed by a key. Closing its scope interrupts all fibers, and completed fibers remove themselves. Starting a new fiber under an existing key can replace and interrupt the previous one. See [`node_modules/effect/src/FiberMap.ts`](../../node_modules/effect/src/FiberMap.ts), lines 1–200.

**Application to Friday:** use `FiberMap` for active per-Turn or per-Thread background workers that need supervision or keyed replacement. Do not use it as the Thread runtime registry itself; `LayerMap`/`RcMap` owns resources, while `FiberMap` owns running work.

### 5. A registry service matches simultaneous interface integrations

Effect's EventLog `Registry` stores several implementations/handlers in maps behind one context service. Registrations use `Effect.acquireRelease`, so entries are removed when the registration scope closes. See [`node_modules/effect/src/unstable/eventlog/EventLog.ts`](../../node_modules/effect/src/unstable/eventlog/EventLog.ts), around lines 70–180.

**Application to Friday:** Discord, Slack, Linear, and Web can register simultaneously with a singleton `Interfaces` registry/router service. Each integration remains a separately scoped live resource, but application code publishes through the registry based on the binding's interface kind. Scoped registration prevents stale adapters after shutdown.

For a fixed compile-time set of implementations, a `ReadonlyMap` built in `Layer.effect` is enough. Dynamic registration is useful only if integrations are composed independently or can start and stop during process lifetime.

### 6. Test substitution is layer substitution

Effect examples define the same service tag and provide fake implementations with `Layer.succeed` or `Layer.effect`. The AI `Chat` documentation demonstrates a stateful service provided by `Layer.effect(Chat.Chat, Chat.empty)` and a fake language model provided as another layer. See [`node_modules/effect/src/unstable/ai/Chat.ts`](../../node_modules/effect/src/unstable/ai/Chat.ts), around lines 35–85.

**Application to Friday:** tests should provide `Friday`, `ThreadRuntimes`, and interface-router test layers. A mutable event journal can live inside the test layer and be exposed through a separate test probe service. Tests should not require production constructors.

## Recommended shape

```text
Friday service (singleton)
├── ThreadPersistence service
├── ThreadRuntimes service/factory
│   └── open(Thread) -> scoped ThreadRuntime instance
├── ThreadSessions keyed resource service
│   └── ThreadId -> scoped ThreadCoordinator + ThreadRuntime
└── Interfaces service/registry
    ├── Discord interface (scoped live integration)
    ├── Slack interface (scoped live integration)
    ├── Linear interface (scoped live integration)
    ├── Web interface (scoped live integration)
    └── Test interface (test layer + probe)
```

## Naming conclusion

- `FridayApplication` → `Friday`
- `FridayApplicationContract` → `FridayContract`
- remove public `makeFridayApplication` / do not add public `makeFriday`
- `ThreadRuntimeFactory` → `ThreadRuntimesContract` or `ThreadRuntimeFactoryContract`, exposed as a service
- keep `makePiThreadRuntime` as an adapter-internal constructor for one runtime instance
- replace “External Platform” with a domain term describing the role. `Interface` is more precise than `Platform`; `Surface` is also viable but is less explicit in code.

## Important distinction

A resource can be both constructed internally and exposed as a service. The decision is not whether construction exists; it is whether ordinary application code is allowed to construct the capability. Friday's singleton capabilities should be obtained from context. Only runtime/resource owners should construct per-Thread instances.
