/* oxlint-disable effecttsgo/node-builtin-import -- Vitest configuration runs outside the Effect application runtime. */

import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      name: 'markdown-text',
      enforce: 'pre',
      load(id) {
        return id.endsWith('.md')
          ? `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`
          : null
      },
    },
  ],
})
