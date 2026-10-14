import { $ } from 'bun'
import { join, relative } from 'node:path'

const buildId = crypto.randomUUID()
const app = join(import.meta.dir, '..')
const output = join(app, 'dist/frontend')
const outfileIndex = process.argv.indexOf('--outfile')
const outfile = outfileIndex >= 0 ? process.argv[outfileIndex + 1] : join(app, 'dist/wednesday')
if (!outfile) throw new Error('An output path is required after --outfile')
await $`pnpm exec tailwindcss -i ${join(app, 'src/client/styles.css')} -o ${join(app, 'src/client/styles.generated.css')} --minify`

// HTML imports in a compiled Bun build flatten dynamic imports into one file.
// Build browser chunks first, then embed each file in the single executable.
const frontend = await Bun.build({
  entrypoints: [join(app, 'src/client/index.html')],
  outdir: output,
  target: 'browser',
  loader: { '.webmanifest': 'file' },
  splitting: true,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', FRIDAY_BUILD_ID: JSON.stringify(buildId) },
})
if (!frontend.success) throw new Error(frontend.logs.map(String).join('\n'))
// Stable install URLs must also be embedded in the single executable.
const installAssets = [
  { name: 'pwa/icon-192.png', mime: 'image/png' },
  { name: 'pwa/icon-512.png', mime: 'image/png' },
  { name: 'pwa/icon-maskable-512.png', mime: 'image/png' },
].map(({ name, mime }) => ({
  path: join(app, 'src/client/public', name),
  url: `/${name}`,
  mime,
  html: false,
}))
const assets = [
  ...frontend.outputs.map((file) => ({
    path: file.path,
    url: `/${relative(output, file.path)}`,
    mime: file.path.endsWith('.webmanifest') ? 'application/manifest+json' : file.type,
    html: file.path.endsWith('.html'),
  })),
  ...installAssets,
]
const imports = assets.map(
  (file, index) => `import asset${index} from ${JSON.stringify(file.path)} with { type: 'file' }`,
)
const files = assets.map(
  (file, index) =>
    `{ path: asset${index}, url: ${JSON.stringify(file.url)}, mime: ${JSON.stringify(file.mime)}, html: ${file.html} }`,
)
const compiled = await Bun.build({
  entrypoints: [join(app, 'src/main.ts')],
  target: 'bun',
  compile: { outfile },
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"', FRIDAY_BUILD_ID: JSON.stringify(buildId) },
  plugins: [
    {
      name: 'embedded-frontend',
      setup(build) {
        build.onResolve({ filter: /^wednesday:frontend$/ }, () => ({
          path: 'assets',
          namespace: 'embedded-frontend',
        }))
        build.onLoad({ filter: /.*/, namespace: 'embedded-frontend' }, () => ({
          contents: `${imports.join('\n')}\nexport default [${files.join(',\n')}]`,
          loader: 'ts',
        }))
      },
    },
  ],
})
if (!compiled.success) throw new Error(compiled.logs.map(String).join('\n'))
console.log(`Built Friday with ${assets.length} embedded frontend assets`)
