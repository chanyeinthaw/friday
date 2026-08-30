const tag = process.argv[2]
const tagPattern = /^v\d+\.\d+\.\d+-[0-9A-Za-z]{7}$/

if (!tagPattern.test(tag ?? '')) {
  console.error('Expected release tag in the form vX.Y.Z-XXXXXXX')
  process.exit(1)
}

const targets = [
  ['bun-linux-x64', 'linux-x64'],
  ['bun-linux-arm64', 'linux-arm64'],
  ['bun-darwin-x64', 'macos-x64'],
  ['bun-darwin-arm64', 'macos-arm64'],
] as const

await Bun.$`rm -rf dist/release`
await Bun.$`mkdir -p dist/release`

for (const [bunTarget, artifactTarget] of targets) {
  const binaryName = `friday-${tag}-${artifactTarget}`
  const binaryPath = `dist/release/${binaryName}`
  await Bun.$`bun build --compile --target=${bunTarget} ./apps/friday/src/main.ts --outfile ${binaryPath}`
  await Bun.$`tar -C dist/release -czf ${binaryPath}.tar.gz ${binaryName}`
  await Bun.$`rm ${binaryPath}`
}

await Bun.$`cd dist/release && sha256sum *.tar.gz > SHA256SUMS`
