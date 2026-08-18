import type {
  OffscreenBrowserOpenPages,
  OffscreenBrowserPage
} from './offscreen-browser-open-pages'
import {
  selectOffscreenBrowserPagesToClose,
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
  /** Anything depending on the page's renderer right now. */
  isPinned: (page: OffscreenBrowserPage) => boolean
  park: (browserPageId: string) => Promise<void>
  close: (browserPageId: string) => Promise<void>
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
    await this.closeOverRetainedPages()
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

  // Why: parking bounds renderer processes, not the records behind them. An
  // agent that opens pages forever and closes none would still grow the backend
  // without limit, so the oldest parked pages are eventually closed outright.
  private async closeOverRetainedPages(): Promise<void> {
    const doomed = selectOffscreenBrowserPagesToClose(
      this.deps.pages.parked().map((page) => this.toCandidate(page)),
      this.deps.pages.size,
      this.deps.policy
    )
    for (const browserPageId of doomed) {
      // Why: closing is destructive and awaits teardown, so a page selected
      // here can be woken before its turn comes. Only close one that is still
      // parked and still unwanted.
      const page = this.deps.pages.get(browserPageId)
      if (!page || page.window || !this.isSafeToReclaim(browserPageId)) {
        continue
      }
      console.warn(
        `[offscreen-browser] closing parked page ${browserPageId}: more than ${this.deps.policy.retainedPageLimit} pages are open`
      )
      await this.deps.close(browserPageId)
    }
  }

  private toCandidate(page: OffscreenBrowserPage): {
    browserPageId: string
    lastActivityAt: number
    pinned: boolean
  } {
    return {
      browserPageId: page.browserPageId,
      lastActivityAt: page.lastActivityAt,
      pinned: this.deps.isPinned(page)
    }
  }

  private isSafeToReclaim(browserPageId: string): boolean {
    const page = this.deps.pages.get(browserPageId)
    if (!page || this.deps.isReleasing(browserPageId)) {
      return false
    }
    return (
      !this.deps.isPinned(page) &&
      this.deps.now() - page.lastActivityAt >= this.deps.policy.parkGraceMs
    )
  }
}
