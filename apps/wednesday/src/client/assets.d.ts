declare module '*.css' {}
declare module 'wednesday:frontend' {
  const files: readonly {
    readonly path: string
    readonly url: `/${string}`
    readonly mime: string
    readonly html: boolean
  }[]
  export default files
}
