// Why (STA-4341): on a headless `orca serve` host every agent-opened browser
// page is backed by its own hidden BrowserWindow, i.e. its own renderer
// process. Nothing owned those renderers, so a long agent session accumulated
// them until the host saturated. This module is the policy half of that owner:
// given the resident pages it decides which ones to park (drop the renderer,
// keep the page). It mirrors terminal hidden-view parking — the cap is the
// primary evictor, the idle clock is the tail — and is pure so the decision is
// testable without Electron.

/** Resident renderers kept warm. Matches TERMINAL_WORKTREE_HOT_RETAIN_LIMIT. */
export const OFFSCREEN_BROWSER_RESIDENT_LIMIT = 4
/** An untouched page parks once idle this long, even under the cap. */
export const OFFSCREEN_BROWSER_IDLE_PARK_MS = 5 * 60_000
/** A page is never parked before this much time without a command. */
export const OFFSCREEN_BROWSER_PARK_GRACE_MS = 30_000

/** How often the backend re-evaluates which pages should be resident. */
export const OFFSCREEN_BROWSER_SWEEP_INTERVAL_MS = 15_000

export type OffscreenBrowserReclaimPolicy = {
  residentLimit: number
  idleParkMs: number
  parkGraceMs: number
  sweepIntervalMs: number
}

export type OffscreenBrowserReclaimCandidate = {
  browserPageId: string
  lastActivityAt: number
  /** Never parked: a client is streaming it, or a command is in flight. */
  pinned: boolean
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) {
    return fallback
  }
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

export function readOffscreenBrowserReclaimPolicy(): OffscreenBrowserReclaimPolicy {
  return {
    residentLimit: readPositiveIntEnv(
      'ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT',
      OFFSCREEN_BROWSER_RESIDENT_LIMIT
    ),
    idleParkMs: readPositiveIntEnv(
      'ORCA_HEADLESS_BROWSER_PARK_IDLE_MS',
      OFFSCREEN_BROWSER_IDLE_PARK_MS
    ),
    parkGraceMs: readPositiveIntEnv(
      'ORCA_HEADLESS_BROWSER_PARK_GRACE_MS',
      OFFSCREEN_BROWSER_PARK_GRACE_MS
    ),
    sweepIntervalMs: Math.max(
      100,
      readPositiveIntEnv('ORCA_HEADLESS_BROWSER_PARK_SWEEP_MS', OFFSCREEN_BROWSER_SWEEP_INTERVAL_MS)
    )
  }
}

/**
 * Pick the resident pages to park, least-recently-used first.
 *
 * Pinned pages are never returned, so the resident cap can be exceeded by
 * pages a client is actively watching — bounding those would break the
 * legitimate browser work the cap exists to protect.
 */
export function selectOffscreenBrowserPagesToPark(
  residentPages: readonly OffscreenBrowserReclaimCandidate[],
  now: number,
  policy: OffscreenBrowserReclaimPolicy
): string[] {
  // Why: a page used moments ago is the one an agent is mid-workflow on; the
  // grace floor applies to eviction by cap as well as by clock.
  const parkable = residentPages
    .filter((page) => !page.pinned && now - page.lastActivityAt >= policy.parkGraceMs)
    .sort(
      (left, right) =>
        left.lastActivityAt - right.lastActivityAt ||
        left.browserPageId.localeCompare(right.browserPageId)
    )

  const parked = new Set<string>()
  for (const page of parkable) {
    if (now - page.lastActivityAt >= policy.idleParkMs) {
      parked.add(page.browserPageId)
    }
  }

  // Why: the cap counts every resident page, pinned ones included — the budget
  // is renderer processes on the host, not just the evictable ones.
  let resident = residentPages.length - parked.size
  for (const page of parkable) {
    if (resident <= policy.residentLimit) {
      break
    }
    if (parked.has(page.browserPageId)) {
      continue
    }
    parked.add(page.browserPageId)
    resident--
  }

  return parkable.map((page) => page.browserPageId).filter((id) => parked.has(id))
}
