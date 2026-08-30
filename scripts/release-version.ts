const tag = process.argv[2]
const tagPattern = /^v(\d+\.\d+\.\d+)-([0-9A-Za-z]{7})$/
const match = tagPattern.exec(tag ?? '')

if (!match) {
  console.error('Expected release tag in the form vX.Y.Z-XXXXXXX')
  process.exit(1)
}

const [, semver, build] = match
const version = `${semver}-${build}`
const packagePaths = ['package.json', 'apps/friday/package.json'] as const

for (const path of packagePaths) {
  const packageJson = await Bun.file(path).json()
  packageJson.version = version
  await Bun.write(path, `${JSON.stringify(packageJson, null, 2)}\n`)
}

const cliPath = 'apps/friday/src/Cli.ts'
const cli = await Bun.file(cliPath).text()
const updatedCli = cli.replace(
  /export const FRIDAY_VERSION = '[^']+'/,
  `export const FRIDAY_VERSION = '${version}'`,
)

if (!/export const FRIDAY_VERSION = '[^']+'/.test(cli)) {
  console.error(`Could not find FRIDAY_VERSION in ${cliPath}`)
  process.exit(1)
}

await Bun.write(cliPath, updatedCli)
console.log(version)
