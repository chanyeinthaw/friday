/**
 * Bounded idempotency guard for platform posts. The model must supply an
 * idempotency key with every post; the key is scoped to the current
 * connection, so the same key on another connection is unrelated.
 *
 * Same key plus same payload returns the prior result without posting again.
 * Same key plus a different payload rejects: the key was already spent. A
 * failed post never poisons its key, so retrying the same key and payload
 * after a failure posts once the transport recovers.
 *
 * Concurrency-safe: concurrent callers sharing a key join the single
 * in-flight post instead of posting twice. The completed cache is bounded
 * FIFO; eviction only means an old key may post again, never a wrong result.
 * This is a mechanical backstop, not the authorization: posts still require
 * an explicit user instruction.
 */
export interface PlatformPostReceipt<Result> {
  readonly payload: string
  readonly result: Result
}

const DefaultCapacity = 500

export class PlatformPostIdempotency {
  private readonly completed = new Map<string, PlatformPostReceipt<unknown>>()
  private readonly inFlight = new Map<string, Promise<PlatformPostReceipt<unknown>>>()
  private readonly capacity: number

  constructor(capacity: number = DefaultCapacity) {
    this.capacity = capacity
  }

  /**
   * Runs `post` once per key. Returns the stored result when the key was
   * already completed with an identical payload; throws when the key was
   * completed with a different payload.
   */
  run<Result>(key: string, payload: string, post: () => Promise<Result>): Promise<Result> {
    const prior = this.completed.get(key)
    if (prior !== undefined) {
      if (prior.payload !== payload) {
        return Promise.reject(
          new Error('Idempotency key was already used with a different post payload.'),
        )
      }
      // SAFETY: receipts are stored per key with the payload checked above,
      // so a matching payload implies the stored result has this call's type.
      return Promise.resolve(prior.result as Result)
    }
    const ongoing = this.inFlight.get(key)
    if (ongoing !== undefined) {
      return ongoing.then((receipt) => {
        if (receipt.payload !== payload) {
          throw new Error('Idempotency key was already used with a different post payload.')
        }
        // SAFETY: same per-key payload check as above for the joined flight.
        return receipt.result as Result
      })
    }
    const flight = post().then(
      (result) => {
        this.inFlight.delete(key)
        const receipt: PlatformPostReceipt<unknown> = { payload, result }
        this.store(key, receipt)
        return receipt
      },
      (cause) => {
        this.inFlight.delete(key)
        throw cause
      },
    )
    this.inFlight.set(key, flight)
    // SAFETY: the flight stores exactly the result its own post produced.
    return flight.then((receipt) => receipt.result as Result)
  }

  private store(key: string, receipt: PlatformPostReceipt<unknown>): void {
    this.completed.delete(key)
    this.completed.set(key, receipt)
    while (this.completed.size > this.capacity) {
      const oldest = this.completed.keys().next()
      if (oldest.done === true) return
      this.completed.delete(oldest.value)
    }
  }
}

/**
 * Scopes a caller-supplied idempotency key to one platform connection.
 * JSON encoding keeps the boundary unambiguous for any key content.
 */
export const scopeIdempotencyKey = (connectionId: string, key: string): string =>
  JSON.stringify([connectionId, key])

/** Process-wide guard shared by every post tool instance in this process. */
export const sharedPlatformPostIdempotency = new PlatformPostIdempotency()
