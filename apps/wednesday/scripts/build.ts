import { $ } from 'bun'
import { join, relative } from 'node:path'

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
  splitting: true,
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!frontend.success) throw new Error(frontend.logs.map(String).join('\n'))
const imports = frontend.outputs.map(
  (file, index) => `import asset${index} from ${JSON.stringify(file.path)} with { type: 'file' }`,
)
const files = frontend.outputs.map(
  (file, index) =>
    `{ path: asset${index}, url: ${JSON.stringify(`/${relative(output, file.path)}`)}, mime: ${JSON.stringify(file.type)}, html: ${file.path.endsWith('.html')} }`,
)
const compiled = await Bun.build({
  entrypoints: [join(app, 'src/main.ts')],
  target: 'bun',
  compile: { outfile },
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
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
console.log(`Built Wednesday with ${frontend.outputs.length} embedded frontend assets`)
