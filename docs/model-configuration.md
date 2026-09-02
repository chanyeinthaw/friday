# Model configuration and catalog inspection

Friday keeps model choices and the Pi catalog separate.

## Friday-owned selections and profiles

`friday config model` reads and writes the two fixed selections in Friday's SQLite database:

```text
friday config model list [--json]
friday config model get <primary|utility> [--json]
friday config model set <primary|utility> --provider <provider> --model-id <model-id> --thinking <level>
```

`primary` is the channel-agent selection used when Friday bootstraps a new channel thread. `utility` is used for utility generation such as conversation titles. Writes do not require the provider or model to exist in Pi's current catalog. This keeps persisted Friday configuration independent of catalog refreshes.

Subagent profiles use a separate namespace:

```text
friday config profile list [--json]
friday config profile get <name> [--json]
friday config profile add <name> --description <description> --provider <provider> --model-id <model-id> --thinking <level>
friday config profile update <name> [--description <description>] [--provider <provider>] [--model-id <model-id>] [--thinking <level>]
friday config profile remove <name> --yes
```

The subagent profile named `primary` is the default for delegated tasks. It is not the channel-agent `primary` selection above. Friday allows updates to this profile but protects it from removal.

After a successful SQLite mutation, the CLI requests a configuration reload from the running Friday process. The request happens after the database operation commits. If Friday is stopped, the write still succeeds and the next start loads it. Reload swaps the validated configuration snapshot without interrupting active turns. Existing tasks, threads, and open runtimes keep the models they already resolved.

Friday stores provider IDs, model IDs, thinking levels, profile names, and descriptions. It never stores provider credentials in these tables.

## Pi-owned catalog

The top-level `friday model` namespace inspects Pi's runtime catalog and local authentication availability:

```text
friday model list [--provider <provider>] [--available] [--json]
friday model get <provider> <model-id> [--json]
friday model reload
```

Catalog output excludes credentials, request headers, and secret values. `--available` filters to models whose provider authentication is configured according to Pi.

`friday model reload` re-reads Pi's local `models.json`, cached provider catalog data, and authentication metadata through Pi's public runtime API. It forces `allowNetwork: false`, does not edit `models.json`, and does not change Friday task or thread records. It also does not replace active runtimes.
