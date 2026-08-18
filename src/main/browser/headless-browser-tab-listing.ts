import type { BrowserTabInfo } from '../../shared/runtime-types'
import type { ParkedBrowserPage } from './browser-backend'

// Why (STA-4341): a headless page whose renderer has been reclaimed is parked,
// not closed. Every surface that enumerates headless pages — the CLI's
// `tab list`, the session-tab snapshot a paired client renders, worktree
// teardown — has to see it, or the page silently disappears from the client
// while the runtime still owns it. One merge keeps those surfaces agreeing.

export function mergeParkedBrowserTabs(
  live: readonly BrowserTabInfo[],
  parked: readonly ParkedBrowserPage[]
): BrowserTabInfo[] {
  if (parked.length === 0) {
    return [...live]
  }
  // Why: parking clears the bridge's active pointer, which then lands on a
  // surviving live tab. A parked page may only claim active when nothing live
  // does, and at most one may — `active` is a single selection, so a listing
  // that reports two is not something any caller can act on.
  let activeClaimed = live.some((tab) => tab.active)
  const merged = [...live]
  for (const page of parked) {
    const active = !activeClaimed && page.active === true
    activeClaimed = activeClaimed || active
    merged.push({
      browserPageId: page.browserPageId,
      index: merged.length,
      url: page.url,
      title: page.title,
      active,
      parked: true,
      // Why: a page that failed to load is still failed while parked; hiding
      // that would show a broken page as healthy at its address.
      loadError: page.loadError ?? null,
      worktreeId: page.worktreeId ?? null,
      profileId: page.profileId ?? null
    })
  }
  return merged
}
