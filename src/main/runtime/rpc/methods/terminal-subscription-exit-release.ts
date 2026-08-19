import type { OrcaRuntimeService } from '../../orca-runtime'

// Why: waitForTerminal({ condition: 'exit' }) only ever *resolves* on a real exit. Every
// rejection it can produce means the handle was momentarily unresolvable — renderer reload
// and desktop window close reject/throw these for ordinary graph-backed terminals — so
// treating a rejection as an exit blanks a terminal whose PTY is still running.
const UNRESOLVED_TERMINAL_HANDLE_ERRORS = new Set(['terminal_handle_stale', 'runtime_unavailable'])

const EXIT_WAITER_REARM_BASE_DELAY_MS = 250
const EXIT_WAITER_REARM_MAX_DELAY_MS = 30_000

function isUnresolvedTerminalHandleError(error: unknown): boolean {
  return error instanceof Error && UNRESOLVED_TERMINAL_HANDLE_ERRORS.has(error.message)
}

/**
 * Releases a terminal subscription when its terminal genuinely exits, re-arming across the
 * windows where the handle cannot be resolved instead of tearing the live stream down.
 *
 * Returns a stop function; callers must invoke it from their subscription cleanup so the
 * re-arm cannot outlive the stream it would release.
 */
export function releaseSubscriptionOnTerminalExit(options: {
  runtime: Pick<OrcaRuntimeService, 'waitForTerminal'>
  terminal: string
  signal?: AbortSignal
  release: () => void
}): () => void {
  const { runtime, terminal, signal, release } = options
  let stopped = false
  let rearmTimer: ReturnType<typeof setTimeout> | null = null
  let rearmDelayMs = EXIT_WAITER_REARM_BASE_DELAY_MS

  const stop = (): void => {
    stopped = true
    if (rearmTimer) {
      clearTimeout(rearmTimer)
      rearmTimer = null
    }
  }

  const arm = (): void => {
    if (stopped || signal?.aborted) {
      return
    }
    void runtime
      .waitForTerminal(terminal, { condition: 'exit', signal })
      .then(() => {
        stop()
        release()
      })
      .catch((error: unknown) => {
        if (stopped) {
          return
        }
        // Why: an aborted signal is the socket going away, not graph churn — release so the
        // waiter cannot outlive its connection (STA-4510's leak guard).
        if (signal?.aborted || !isUnresolvedTerminalHandleError(error)) {
          stop()
          release()
          return
        }
        // Why: back off rather than spin — while the graph is unavailable the next lookup
        // rejects synchronously, and the handle may not return until a window reopens.
        rearmTimer = setTimeout(() => {
          rearmTimer = null
          arm()
        }, rearmDelayMs)
        if (typeof rearmTimer.unref === 'function') {
          rearmTimer.unref()
        }
        rearmDelayMs = Math.min(rearmDelayMs * 2, EXIT_WAITER_REARM_MAX_DELAY_MS)
      })
  }

  arm()
  return stop
}
