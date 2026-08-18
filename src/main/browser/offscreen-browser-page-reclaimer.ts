import type {
  OffscreenBrowserOpenPages,
  OffscreenBrowserPage
} from './offscreen-browser-open-pages'
import {
  selectOffscreenBrowserPagesToPark,
  type OffscreenBrowserReclaimPolicy
} from './offscreen-browser-page-reclaim'

// Why (STA-4341): the sweep that decides which headless pages keep a renderer,
// separated from the backend that owns the renderers themselves. It is the
// headless counterpart of the desktop guest budget in
// browser-guest-worktree-retention.ts — same intent, different unit: desktop
// evicts a hidden worktree's guests on UI visibility, headless evicts an
// individual page on command activity, because a headless host has no UI and an
// agent lives in one worktree.

export type OffscreenBrowserReclaimerDeps = {
  pages: OffscreenBrowserOpenPages
  policy: OffscreenBrowserReclaimPolicy
  /** A teardown this backend already started for the page. */
  isReleasing: (browserPageId: string) => boolean
  /** A wake still rebuilding the page's renderer. */
  isWaking: (browserPageId: string) => boolean
  /** A certificate challenge the page is blocked on. */
  hasCertificateChallenge: (browserPageId: string) => boolean
  /** A download the page is still writing. */
  hasActiveDownload: (browserPageId: string) => boolean
  /** A client streaming the page, or a command in flight against it. */
  isHostPinned: (browserPageId: string) => boolean
  park: (browserPageId: string) => Promise<void>
  now: () => number
}

export class OffscreenBrowserPageReclaimer {
  private sweepTimer: NodeJS.Timeout | null = null
  private sweepInFlight: Promise<unknown> | null = null

  constructor(private readonly deps: OffscreenBrowserReclaimerDeps) {}

  /** Park every page the policy no longer wants resident. */
  async sweep(): Promise<string[]> {
    const resident = this.deps.pages
      .resident()
      .filter((page) => !this.deps.isReleasing(page.browserPageId))
    const doomed = selectOffscreenBrowserPagesToPark(
      resident.map((page) => this.toCandidate(page)),
      this.deps.now(),
      this.deps.policy
    )
    const parked: string[] = []
    for (const browserPageId of doomed) {
      // Why: parking awaits the helper session's teardown, so a page later in
      // this list can be woken and driven while an earlier one is still being
      // torn down. The selection is a proposal, not a licence — re-check each
      // page against live state before destroying its renderer.
      if (!this.isSafeToReclaim(browserPageId)) {
        continue
      }
      await this.deps.park(browserPageId)
      parked.push(browserPageId)
    }
    return parked
  }

  ensureScheduled(): void {
    if (this.sweepTimer) {
      return
    }
    this.sweepTimer = setInterval(() => {
      // Why: a park waits on the helper session's own bounded teardown, which
      // can outlast the interval. Without this guard slow teardowns would stack
      // sweeps on top of each other for as long as they lag.
      if (this.sweepInFlight) {
        return
      }
      const sweep = this.sweep().catch(() => {
        // A failed park is retried on the next sweep.
      })
      this.sweepInFlight = sweep
      void sweep.finally(() => {
        if (this.sweepInFlight === sweep) {
          this.sweepInFlight = null
        }
      })
    }, this.deps.policy.sweepIntervalMs)
    // Why: reclamation must never be the reason the process stays alive.
    this.sweepTimer.unref?.()
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.sweepInFlight = null
  }

  // Why: a page is off limits while anything depends on its renderer — a client
  // streaming it, a command in flight, its first navigation still committing, a
  // wake still rebuilding it, a certificate decision it is blocked on, or a
  // download it is still writing. `loading` is bounded by the load helper's own
  // timeout, so it cannot hold a renderer forever; a navigation still pending
  // past that timeout is deliberately parkable, and waking retries the address.
  private isPinned(page: OffscreenBrowserPage): boolean {
    return (
      page.loading ||
      this.deps.isWaking(page.browserPageId) ||
      // Why: a challenge id dies with the renderer, so parking would discard
      // both the warning and the ability to approve it.
      this.deps.hasCertificateChallenge(page.browserPageId) ||
      // Why: releasing a renderer unregisters its guest, and that cancels the
      // page's in-flight downloads. Mirrors the desktop guest budget's veto
      // (browser-guest-worktree-retention.ts).
      this.deps.hasActiveDownload(page.browserPageId) ||
      this.deps.isHostPinned(page.browserPageId)
    )
  }

  private toCandidate(page: OffscreenBrowserPage): {
    browserPageId: string
    lastActivityAt: number
    pinned: boolean
  } {
    return {
      browserPageId: page.browserPageId,
      lastActivityAt: page.lastActivityAt,
      pinned: this.isPinned(page)
    }
  }

  private isSafeToReclaim(browserPageId: string): boolean {
    const page = this.deps.pages.get(browserPageId)
    if (!page || this.deps.isReleasing(browserPageId)) {
      return false
    }
    return (
      !this.isPinned(page) && this.deps.now() - page.lastActivityAt >= this.deps.policy.parkGraceMs
    )
  }
}
