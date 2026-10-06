# Configure an endless OptChat channel

Each OptChat binding connects one native channel and one owner to a permanent memory ID. Other channels keep their existing Friday behavior.

## Add a binding

1. Configure and enable the platform connection and admit the channel through the existing Discord guild or Slack workspace/channel policy.
2. Choose an unused memory ID and identify the channel owner's platform user ID.
3. When the channel is idle, add the binding:

   ```sh
   friday config optchat add chan-main discord personal-discord CHANNEL_ID OWNER_USER_ID
   ```

   For Slack:

   ```sh
   friday config optchat add pinn-main slack personal-slack CHANNEL_ID OWNER_USER_ID
   ```

   Use native channel IDs, without Friday's `discord:` or `slack:` prefixes. The command saves the binding and requests configuration reload.

4. Send a top-level channel message as the owner. No mention is required. Friday replies directly in the channel.
5. List bindings:

   ```sh
   friday config optchat list
   ```

One binding owns each channel. Owner and channel identities are immutable. Repeating `add` with the same arguments re-enables an existing binding.

## Import Pi session history

To load an earlier Pi session JSONL transcript into a memory, run the import when the channel is idle:

```sh
friday config optchat import chan-main /path/to/session.jsonl --dry-run
friday config optchat import chan-main /path/to/session.jsonl
```

The memory ID must have an enabled binding. The import reads the file without modifying it, follows only the active session branch, and appends the mapped messages in one transaction. Repeating an import adds nothing twice: source keys combine the session ID, entry ID, and message indexes, so a grown session appends only its new entries. Add `--json` for machine-readable counts.

## Disable and re-enable a binding

When the channel is idle, disable the binding:

```sh
friday config optchat disable chan-main
```

The channel returns to normal Friday behavior. Its OptChat history and summaries remain stored. Repeat the original `add` command to re-enable the same memory. Messages from the disabled interval are excluded from that memory.

Bindings do not grant access to otherwise excluded guilds, workspaces, or channels. In an admitted OptChat channel, only the owner invokes Friday. Native-thread messages do not enter the endless chat.

## Choose a summarization model

OptChat uses Friday's configured utility model and thinking level. Choose a model that can summarize accurately and accept the memory view plus a complete source message:

```sh
friday config model set utility --provider PROVIDER --model-id MODEL_ID --thinking medium
```

Utility calls also serve routing and titles in normal channels. Model changes preserve each OptChat memory.

## Inspect the implementation

See [OptChat memory behavior](optchat-memory.md) for storage, recovery, and differences from the reference specification.
