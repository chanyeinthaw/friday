# 06. Security and operations

## Security strengths

### Secret handling

**Observed.** Discord and Slack connection rows store environment variable names rather than token
values. The application resolves secrets when loading configuration. Logs annotate connection IDs
and policy counts, not credentials.

### Admission policy

**Observed.** Unknown platform scopes and denied users fail closed. Raw messages are dropped before
thread creation where possible, and shared admission repeats the authoritative decision after
projection. Root-user data is scoped to the current binding before prompt rendering.

### Local control socket

**Observed.** The Unix socket is owner-only, uses a lifecycle lock with token and process identity,
rejects a live competing server, limits response size, applies a request deadline, destroys stalled
connections on shutdown, and avoids deleting a successor socket.

### Worktree cleanup

**Observed.** Cleanup requires a recorded proposal, checks workspace containment, re-inspects the
approved snapshots, detects staleness, and tracks removal progress. Dirty worktrees are not removed
from an unverified filesystem scan.

### Private documents

**Observed.** Document authorization uses 32 random bytes, constant-time comparison, uniform 404
responses, `no-store`, `no-referrer`, `nosniff`, no indexing, a restrictive CSP, and HTML attribute
allow-listing. Paths are schema-constrained and canonicalized before reads.

## Finding S1: secret document URLs can leak outside the process

Severity: medium
Claim: inferred operational risk

The application itself does not log the `auth` query value. A reverse proxy, access log, browser
history, copied message, screenshot, or monitoring system may still record the full URL. The
`Referrer-Policy: no-referrer` response protects navigation away from the document but cannot
control logs written before the response.

### Recommendation

- Configure the reverse proxy to redact the `auth` query parameter.
- Keep access logs off for `/files/*` or log only path and status.
- Document that URLs are bearer credentials.
- Consider storing a hash of the access key in SQLite. Verification only needs the hash, while the
  plaintext key is returned once and can be rotated.

## Finding S2: custom HTML sanitization carries ongoing review cost

Severity: low
Claim: inferred risk

[`DocumentRendering.ts`](../../apps/friday/src/documents/DocumentRendering.ts) implements a custom
regex-based sanitizer. Its strict CSP blocks scripts and objects, which is an important second line
of defense. Still, HTML parsing has edge cases and every new allowed tag or attribute expands the
security review burden.

### Recommendation

Prefer Markdown-only documents if raw HTML is not required. Otherwise use a maintained parser-based
sanitizer compatible with the compiled Bun binary. Keep the current CSP even after replacement.

## Finding S3: file logging has no repository-owned rotation policy

Severity: medium
Claim: observed in repository, external mitigation unknown

[`logging/Live.ts`](../../apps/friday/src/logging/Live.ts) appends JSON logs to one file. No rotation,
retention, or size limit exists in this repository. Supervisor or host configuration may manage it,
but that configuration is outside audit scope.

### Recommendation

Confirm external rotation in the deployed environment. If none exists, add a documented `logrotate`
configuration or size-based application rotation. Treat unbounded logs as a disk-exhaustion risk on
a resident process.

## Finding S4: verification happens late in the release path

Severity: medium
Claim: observed

The only workflow is tag-triggered release. It runs `pnpm verify`, builds four binaries, commits the
version to `main`, and creates a GitHub release. There is no repository workflow that verifies a pull
request or ordinary push before tagging.

### Recommendation

Add pre-merge CI. Preserve the release workflow's frozen install, tag validation, checksums, and
multi-platform build. Consider building one representative binary in CI so compile-only failures do
not first appear after a release tag.

## Operational observations

- Connection topology is intentionally restart-based. The bundled operational skill documents safe
  restart behavior and warns that active conversation work is interrupted.
- The daemon owns Discord gateways, Slack Socket Mode, a local document listener, the control
  socket, SQLite, runtime pools, and daily cleanup notifications in one process. This is suitable
  for the current single-user deployment, but makes graceful shutdown and restart reconciliation
  important.
- No backup or restore tooling for `friday.sqlite` and the document directory appears in this
  repository. Validate the host backup policy, especially because database rows and document files
  must be restored consistently.
