import { $ } from 'bun'

await $`pnpm exec tailwindcss -i ./src/client/styles.css -o ./src/client/styles.generated.css --minify`
await $`bun build ./src/main.ts --compile --minify --define 'process.env.NODE_ENV="production"' --outfile ./dist/wednesday`
