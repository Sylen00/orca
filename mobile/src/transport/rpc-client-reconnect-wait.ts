import type { RpcClient } from './rpc-client'

// Why: after a socket drop the direct client parks a send in waitForConnected, but a
// relay session rejects it outright ('relay session not connected') until the supervisor
// migrates a replacement in. A replay that fires the instant the drop lands therefore
// burns its budget on the dead session, so callers that mean to re-issue an idempotent
// request wait for the transport to come back first.
//
// Unlike waitForAuthenticated, intermediate 'disconnected'/'reconnecting' states are the
// expected path here, not a failure — only the timeout ends the wait unsuccessfully.
export function waitForRpcClientReconnected(
  client: RpcClient,
  timeoutMs: number
): Promise<boolean> {
  if (client.getState() === 'connected') {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    // Armed before subscribing so a synchronous notification during registration
    // still finds a timer to clear.
    const timer = setTimeout(() => finish(false), timeoutMs)
    unsubscribe = client.onStateChange((state) => {
      if (state === 'connected') {
        finish(true)
      }
    })
    if (settled) {
      // The notification fired inside onStateChange, before we held the handle.
      unsubscribe()
      unsubscribe = null
    }

    function finish(reconnected: boolean): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      unsubscribe?.()
      unsubscribe = null
      resolve(reconnected)
    }
  })
}
