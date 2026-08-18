import type { BrowserWindow } from 'electron'
import type { BrowserLoadError } from '../../shared/browser-workspace-types'
import type { ParkedBrowserPage } from './browser-backend'

// Why (STA-4341): a headless browser page and the renderer behind it have
// different lifetimes — the page is open until it is closed, the renderer only
// while something needs it. This is the book of open pages; the backend owns
// the renderers. Keeping them apart is what makes "parked" expressible: a
// record here with no window attached.

export type OffscreenBrowserPage = {
  browserPageId: string
  worktreeId?: string
  profileId?: string
  partition: string
  url: string
  title: string
  /** null while parked — the page exists, its renderer does not. */
  window: BrowserWindow | null
  /** Whether the page was its worktree's active tab when it parked. */
  activeWhenParked: boolean
  /** True while the initial or post-wake navigation is still in flight. */
  loading: boolean
  /** The failure the page reported when its renderer was reclaimed. */
  loadError: BrowserLoadError | null
  lastActivityAt: number
}

function isResident(page: OffscreenBrowserPage): boolean {
  return Boolean(page.window && !page.window.isDestroyed())
}

export class OffscreenBrowserOpenPages {
  private readonly pages = new Map<string, OffscreenBrowserPage>()

  get size(): number {
    return this.pages.size
  }

  has(browserPageId: string): boolean {
    return this.pages.has(browserPageId)
  }

  get(browserPageId: string): OffscreenBrowserPage | undefined {
    return this.pages.get(browserPageId)
  }

  add(page: OffscreenBrowserPage): void {
    this.pages.set(page.browserPageId, page)
  }

  delete(browserPageId: string): OffscreenBrowserPage | undefined {
    const page = this.pages.get(browserPageId)
    this.pages.delete(browserPageId)
    return page
  }

  clear(): void {
    this.pages.clear()
  }

  all(): OffscreenBrowserPage[] {
    return [...this.pages.values()]
  }

  resident(): OffscreenBrowserPage[] {
    return this.all().filter(isResident)
  }

  parked(worktreeId?: string): OffscreenBrowserPage[] {
    return this.all().filter(
      (page) => !isResident(page) && (!worktreeId || page.worktreeId === worktreeId)
    )
  }

  listParked(worktreeId?: string): ParkedBrowserPage[] {
    return this.parked(worktreeId).map((page) => ({
      browserPageId: page.browserPageId,
      worktreeId: page.worktreeId,
      profileId: page.profileId,
      url: page.url,
      title: page.title,
      active: page.activeWhenParked,
      loadError: page.loadError
    }))
  }

  /**
   * The parked page a page-less command should target. Activity order alone is
   * wrong: an explicit `--page B` command makes B the most recently used while
   * A is still the active tab, and a page-less command has always meant "the
   * active tab". So the retained active page wins, and recency only breaks the
   * tie when none is recorded.
   */
  parkedIdForImplicitTarget(worktreeId?: string): string | null {
    let best: OffscreenBrowserPage | null = null
    for (const page of this.parked(worktreeId)) {
      if (page.activeWhenParked) {
        return page.browserPageId
      }
      if (!best || page.lastActivityAt > best.lastActivityAt) {
        best = page
      }
    }
    return best?.browserPageId ?? null
  }

  /** Only one page per worktree may carry the active flag across a park. */
  claimParkedActive(browserPageId: string, worktreeId?: string): void {
    for (const page of this.parked(worktreeId)) {
      if (page.browserPageId !== browserPageId) {
        page.activeWhenParked = false
      }
    }
  }
}
