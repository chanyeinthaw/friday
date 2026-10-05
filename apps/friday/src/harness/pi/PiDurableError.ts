export { PiDurableError } from '@friday/pi-durable-effect'

export interface PiRuntimeObservation {
  readonly runtimePresent: boolean
  readonly activeTurns: number
}
