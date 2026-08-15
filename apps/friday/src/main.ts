import { BunRuntime } from '@effect/platform-bun'
import { Console } from 'effect'

const program = Console.log('Friday is ready.')

BunRuntime.runMain(program)
