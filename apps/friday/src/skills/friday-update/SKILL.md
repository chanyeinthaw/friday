---
name: friday-update
description: Update or restart Friday safely in the packaged Supervisor deployment.
---

# Update Friday

Use the deployment commands when they exist. They handle release checks, checksums, rollback state, and Friday's Supervisor process. Do not replace the binary or call `supervisorctl restart` by hand.

## Inspect

```sh
FRIDAY_BIN="${FRIDAY_HOME:-$HOME/.friday}/bin/friday"
"$FRIDAY_BIN" --version
command -v friday-update
command -v friday-restart
command -v friday-healthcheck
```

If these deployment commands are absent, stop and inspect the host's deployment instructions. Do not invent an update procedure from this skill.

## Update and restart

`friday-update` accepts `latest` or an explicit nightly version:

```sh
friday-update latest
friday-update v0.0.0-nightly.<number>
```

The command downloads the release and `SHA256SUMS`, verifies the archive and candidate version, saves the current binary as `friday.previous`, installs the new binary, records a pending update, and invokes `friday-restart`.

`friday-restart` schedules Friday's Supervisor start from a detached process, then stops the current Friday process. The current conversation will be interrupted. Run it only after finishing all other work in the turn.

When Friday itself performs the update:

1. Finish every unrelated operation first.
2. Tell the user that Friday is about to restart.
3. Run `friday-update` as the final command.
4. Do not run another command or send another progress message after it starts.

Do not wrap `friday-update` in a command chain that expects to continue after the restart.

## Restart without updating

Use this only when a restart is required and no new binary is needed:

```sh
friday-restart
```

Treat it as the final command in the turn for the same reason.

Configuration changes that support live reload should use this instead:

```sh
"$FRIDAY_BIN" config reload
```

A reload is not a restart. Discord connection topology and Discord administrator changes still need a process restart.

## Verify after reconnection

In a new turn or an external shell:

```sh
"$FRIDAY_BIN" --version
friday-healthcheck
```

If needed, inspect Friday's own Supervisor logs under:

```text
$FRIDAY_HOME/logs/
```

Do not restart unrelated Supervisor programs.

## Rollback behavior

The packaged launcher tracks failed starts in `$FRIDAY_HOME/update/pending.json`. After the configured attempt limit, it restores `$FRIDAY_HOME/bin/friday.previous` automatically.

Do not delete `pending.json`, `friday.previous`, or the failed binary while recovery is in progress. If automatic recovery fails, report the active version, health-check output, and Friday log errors before changing files manually.
