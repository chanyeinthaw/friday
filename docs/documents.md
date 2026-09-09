# Private documents

Friday publishes long Markdown or HTML content as private documents behind
unguessable URLs. Publish when splitting across chat would hurt readability,
formatting, or reliable delivery; keep short answers in chat.

## CLI

```text
friday document save <key> [--format <markdown|html>] [--file <path>] [--json]
friday document get <key> [--json]
friday document list [--json]
friday document url <key> [--json]
friday document revoke <key> [--json]
friday document remove <key> --yes
```

`save` reads content from `--file` or stdin (Markdown by default) and returns
the secret URL. Saving the same key overwrites its content in place and keeps
its URL, so retries are stable. `get` prints the stored content and `list`
shows every key with its format and size; neither ever prints URLs. `url`
recovers the current URL, `revoke` replaces the access key and returns a new
URL (the old one stops working), and `remove --yes` deletes the document.

Keys use letters, digits, `-`, and `_` (up to 128 characters, starting with a
letter or digit), for example `weekly-report`.

## URLs and authentication

A document URL looks like `<public-base-url>/files/<key>?auth=<access-key>`.
Each document carries one cryptographically random 32-byte access key, stored
in Friday's SQLite database so `document url` can recover the current link.
Overwrites preserve the key; `revoke` mints a new one; `remove` deletes it.

Missing documents, missing credentials, and wrong credentials all return the
same `404` response. Credentials are compared in constant time and never
logged. The `auth` query value stays out of `list` and `get` output by design.

## Rendering and security headers

Markdown is rendered to structural HTML and every document is sanitized:
scripts, frames, forms, styling, event handlers, and unsafe links are removed.
Pages are bare content only, with no branding, navigation, or JavaScript, and
are served with `Cache-Control: private, no-store`, `Referrer-Policy:
no-referrer`, `X-Content-Type-Options: nosniff`, an `X-Robots-Tag` opting out
of indexing, and a restrictive content security policy.

## Configuration and deployment

Document serving reads one row from the `document_config` table (created with
conservative defaults by migrations):

- `public_base_url` (default `http://127.0.0.1:4020`) — the external origin
  clients use. Set this to the reverse proxy's public origin.
- `listen_host` (default `127.0.0.1`) and `listen_port` (default `4020`) — the
  loopback listener. Friday binds only here; a reverse proxy owns TLS and
  forwards to it. Changing either needs a Friday restart.
- `max_bytes` (default `262144`, 256 KiB) — the largest accepted document.

Stored files live under `$FRIDAY_HOME/documents`. Keys are validated so they
can never traverse or symlink-escape that directory, writes replace files
atomically, and a failed save keeps the previous content.

## Backups are sensitive

SQLite backups contain working document access keys. Anyone holding a backup
can reconstruct every document URL, so store and move backups like secrets.
