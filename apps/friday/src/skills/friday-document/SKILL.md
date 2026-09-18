---
name: friday-document
description: Use when asked to create or upload a document, or when sharing a long report, guide, investigation, or reference.
---

# friday-document

Publish content that would be hard to read, format, or deliver reliably across chat messages as a private document. The reader opens the stored content directly: HTML is served as-is and Markdown as its original text.

## When to publish

Publish when splitting across chat would hurt readability, formatting, or reliable delivery. Publish reports, guides, detailed investigations, and reusable reference material as a private document, then reply in chat with a short summary and the link. Keep ordinary discussion, short explanations, and small code samples in chat. If the reader explicitly asks for chat or a document, follow that choice.

## Workflow

Documents use caller-selected keys. Saving the same key overwrites its content in place and keeps its URL.

```text
friday document save <key> [--format markdown|html] [--file <path>] [--json]
friday document get <key> [--json]
friday document list [--json]
friday document url <key> [--json]
friday document revoke <key> [--json]
friday document remove <key> --yes
```

- `save` reads content from `--file` or stdin. Markdown is the default format. It returns the secret URL; saving the same key again keeps that URL, so reuse the same key for updates.
- `get` prints the stored content (metadata plus content with `--json`). It never prints the URL.
- `list` shows keys and metadata for every document. It never prints URLs.
- `url` recovers the current secret URL for a key, for example to resend it.
- `revoke` replaces the access key and returns a new URL. The old URL stops working.
- `remove --yes` deletes the document. Its URL stops working.

Keys use letters, digits, `-`, and `_` (up to 128 characters, starting with a letter or digit). Pick a descriptive key such as `weekly-report` or `api-notes`.

## Rules

- The URL carries its access key. Share the full URL only with the intended reader, and never paste it where others can see it.
- Never print access keys or full URLs in logs, transcripts, or anywhere except the message to the reader.
- Documents are private but unguessable, not access-controlled: anyone with the URL can read.
- `get` and `list` never return URLs. Use `url` when the current link is needed again.
