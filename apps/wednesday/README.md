# Run Friday

Build the executable from the repository root:

```sh
pnpm --filter @friday/wednesday build
```

The build writes `apps/wednesday/dist/wednesday`. The executable embeds the React frontend with TanStack Router, shadcn chat components, and Effect Atom, and serves the frontend and Effect HttpApi backend from one port. Browser assets are built with code splitting before embedding, so syntax highlighting and diagrams load on demand.

Load the development configuration and start the executable:

```sh
set -a
. ~/.config/wednesday/development.env
set +a
./apps/wednesday/dist/wednesday
```

Open `http://localhost:3002`. Enter your email in the chat composer, then enter the code sent by Clerk. Sign-in replies and errors appear in the chat. Resend the code or change the email from the composer controls. After verification, Friday opens your private conversation. Click the settings icon in the top-right corner. Choose OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages, enter your provider address and access key, find models, and choose a default model. Settings save automatically.

In Provider, choose ChatGPT and select Sign in with ChatGPT. Open the authorization link, enter the displayed device code, and approve access. Friday stores encrypted tokens per user and refreshes them automatically. Device codes expire after 15 minutes. Disconnect removes the saved credentials and keeps conversation history. API key remains available as an alternative.

Choose chat and memory models with independent thinking effort in Settings. Model pickers open as searchable bottom sheets on mobile. Use the gear on a model entry in either picker to adjust its limits, supported thinking levels, and provider options in a desktop dialog or mobile sheet. Provider display names appear when available; model IDs remain the API identifiers. Expand Provider to update your API address or key. Settings save automatically after you finish editing. A toast confirms each successful update. Changes made during a response save when it finishes.

Choose the chat model and thinking effort on the Provider settings page. The rounded composer starts at two lines and grows to four lines before scrolling. On desktop, press **Enter** to send or Shift + Enter for a new line. On touch devices, Enter inserts a new line; tap the send button to send. While Friday is working, messages steer the active turn at its next model-step boundary. **Stop** interrupts the turn and cancels pending steering. Pending messages appear immediately as user bubbles.

Chat initially loads the latest 250 visible messages. Load more at the top fetches earlier messages without moving the current reading position. Responses appear as completed paragraphs and Markdown blocks. The renderer includes syntax highlighting, code wrapping and copying, tables with Markdown and CSV copying, GitHub alerts, footnotes, collapsible details, image previews, and Mermaid diagrams.

Run the checks from the repository root:

```sh
pnpm --filter @friday/wednesday check
pnpm --filter @friday/wednesday test
pnpm --filter @friday/wednesday test:integration
pnpm exec oxlint apps/wednesday --quiet
```

The integration tests compile and run an isolated executable with a temporary SQLite database, locally signed test sessions, and a mock model provider. They verify tenant isolation, steering, encrypted credentials, restart persistence, submission deduplication, concurrent background compaction, failed-summary recovery, and legacy-memory migration.

See [configuration and storage](configuration.md) for runtime settings and implementation limits.

## Docker Compose on Tailscale

Build the Linux executable on the deployment host, then build and start its runtime image:

```sh
pnpm --filter @friday/wednesday build
docker compose -f apps/wednesday/compose.yaml up -d --build
sudo tailscale serve --bg --https=8446 http://127.0.0.1:3002
```

Open `https://silicon.tailcd7ccb.ts.net:8446` from a device connected to Tailscale. Compose uses the development configuration above, overrides the browser origin, and stores SQLite in the `wednesday-development_data` volume. Keep the encryption key and database together when moving the deployment.

Set `WEDNESDAY_ENV_FILE` and `WEDNESDAY_PUBLIC_ORIGIN` to deploy on another host. The Docker build copies the compiled executable; rebuild it before rebuilding the image. The executable contains both frontend and backend and requires no JavaScript source or package installation in the container.

ChatGPT authentication follows [OpenAI's Codex device-code flow](https://developers.openai.com/codex/auth/#preferred-device-code-authentication-beta). Device sign-in may need to be enabled in your ChatGPT security settings or workspace permissions. The provider uses the Codex Responses endpoint and its account model catalog; provider streaming reveals completed Markdown blocks while Fold saves the complete response.
