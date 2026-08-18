import { randomUUID } from 'node:crypto'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserBackend, BrowserBackendCreateTab, ParkedBrowserPage } from './browser-backend'
import type { BrowserManager } from './browser-manager'
import { browserSessionRegistry } from './browser-session-registry'
import {
  readOffscreenBrowserReclaimPolicy,
  selectOffscreenBrowserPagesToClose,
  selectOffscreenBrowserPagesToPark,
  type OffscreenBrowserReclaimPolicy
} from './offscreen-browser-page-reclaim'
import {
  OffscreenBrowserOpenPages,
  type OffscreenBrowserPage
} from './offscreen-browser-open-pages'
import { createOffscreenBrowserWindow, loadOffscreenBrowserUrl } from './offscreen-browser-window'

// Why (STA-4341): this backend is the lifecycle owner for headless browser
// pages. It keeps the page identity an agent holds (`browserPageId`, URL,
// worktree, profile) for as long as the page is open, but treats the renderer
// process behind it as a reclaimable resource: an idle page is parked (renderer
// destroyed, record kept) and woken on the next command that targets it.

export type OffscreenBrowserBackendOptions = {
  getAgentBrowserBridge?: () => AgentBrowserBridge | null
  /** Pages a client is streaming or that have a command in flight. */
  isPagePinned?: (browserPageId: string) => boolean
  now?: () => number
}

export class OffscreenBrowserBackend implements BrowserBackend {
  private readonly pages = new OffscreenBrowserOpenPages()
  /** Renderer teardowns this backend initiated, keyed by page. Park and close
   *  both destroy the window on purpose, so the crash handler stands down for
   *  them — and a wake waits on one rather than racing it. */
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly waking = new Map<string, Promise<boolean>>()
  private readonly policy: OffscreenBrowserReclaimPolicy
  private sweepTimer: NodeJS.Timeout | null = null
  private sweepInFlight: Promise<unknown> | null = null

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly options: OffscreenBrowserBackendOptions = {}
  ) {
    this.policy = readOffscreenBrowserReclaimPolicy()
  }

  async createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }> {
    const browserPageId = params.browserPageId ?? randomUUID()
    if (this.pages.has(browserPageId)) {
      throw new Error(`Browser page ${browserPageId} already exists`)
    }
    // Why: profiles map to Electron partitions; using the profile's partition
    // makes cookies/storage persist in the same SQLite DB the desktop path uses.
    const profile = params.profileId
      ? browserSessionRegistry.getProfile(params.profileId)
      : browserSessionRegistry.getDefaultProfile()
    const url = params.url || 'about:blank'
    const page: OffscreenBrowserPage = {
      browserPageId,
      worktreeId: params.worktreeId,
      profileId: profile?.id ?? undefined,
      partition: profile?.partition ?? ORCA_BROWSER_PARTITION,
      url,
      title: '',
      window: null,
      activeWhenParked: false,
      loading: false,
      lastActivityAt: this.now()
    }
    this.pages.add(page)
    // Why: register the guest and return immediately so the new tab appears
    // without waiting for the page to finish loading. A failed load leaves the
    // (usable) tab open, matching how a normal browser tab survives one.
    this.materialize(page)
    void this.loadPage(page, url).catch((error) => {
      console.warn(
        '[offscreen-browser] page load failed:',
        error instanceof Error ? error.message : String(error)
      )
    })
    this.ensureSweepScheduled()
    return { browserPageId }
  }

  async closeTab(browserPageId: string): Promise<void> {
    const page = this.pages.delete(browserPageId) ?? null
    this.waking.delete(browserPageId)
    await this.releaseRenderer(page, browserPageId)
    if (this.pages.size === 0) {
      this.stopSweep()
    }
  }

  /**
   * Make a page's renderer resident and restart its reclaim clock. Cheap and
   * idempotent for a page that never parked, so command routing can call it
   * unconditionally; that is also what serialises a command against a park
   * that is already tearing the renderer down.
   */
  async wakeTab(browserPageId: string): Promise<boolean> {
    const page = this.pages.get(browserPageId)
    if (!page) {
      return false
    }
    page.lastActivityAt = this.now()
    const releasing = this.releasing.get(browserPageId)
    if (!releasing && page.window && !page.window.isDestroyed()) {
      return true
    }
    const inFlight = this.waking.get(browserPageId)
    if (inFlight) {
      return inFlight
    }
    const wake = (async (): Promise<boolean> => {
      await releasing
      if (!this.pages.has(browserPageId)) {
        return false
      }
      if (page.window && !page.window.isDestroyed()) {
        return true
      }
      page.activeWhenParked = false
      const previousWebContentsId = this.browserManager.getGuestWebContentsId(browserPageId)
      this.materialize(page)
      const bridge = this.options.getAgentBrowserBridge?.() ?? null
      const webContentsId = page.window?.webContents.id
      if (bridge && webContentsId != null) {
        // Why: same page id, new renderer — reuse the existing process-swap
        // path so the stale helper session and CDP proxy are torn down.
        await bridge.onProcessSwap(browserPageId, webContentsId, previousWebContentsId ?? undefined)
      }
      await this.loadPage(page, page.url).catch(() => {
        // A parked page whose URL no longer loads stays open and reports the
        // failure through the same load-error surface as a live page.
      })
      page.lastActivityAt = this.now()
      return true
    })()
    this.waking.set(browserPageId, wake)
    try {
      return await wake
    } finally {
      this.waking.delete(browserPageId)
    }
  }

  listParkedPages(worktreeId?: string): ParkedBrowserPage[] {
    return this.pages.listParked(worktreeId)
  }

  /** Most-recently-used parked page in a worktree, for implicit targeting. */
  getMostRecentlyUsedParkedPageId(worktreeId?: string): string | null {
    return this.pages.mostRecentlyUsedParkedId(worktreeId)
  }

  destroyAll(): void {
    this.stopSweep()
    for (const page of this.pages.all()) {
      this.browserManager.unregisterGuest(page.browserPageId)
      if (page.window && !page.window.isDestroyed()) {
        page.window.destroy()
      }
    }
    this.pages.clear()
    this.waking.clear()
  }

  /** Park every page the policy no longer wants resident. Exposed for tests. */
  async reclaimIdlePages(): Promise<string[]> {
    const now = this.now()
    const resident = this.pages.resident().filter((page) => !this.releasing.has(page.browserPageId))
    const doomed = selectOffscreenBrowserPagesToPark(
      resident.map((page) => ({
        browserPageId: page.browserPageId,
        lastActivityAt: page.lastActivityAt,
        // Why: a page still committing its first navigation has nothing worth
        // keeping yet and would be woken straight back to the same address.
        pinned: page.loading || this.options.isPagePinned?.(page.browserPageId) === true
      })),
      now,
      this.policy
    )
    for (const browserPageId of doomed) {
      await this.parkPage(browserPageId)
    }
    await this.closeOverRetainedPages()
    return doomed
  }

  // Why: parking bounds renderer processes, not the records behind them. An
  // agent that opens pages forever and closes none would still grow the backend
  // without limit, so the oldest parked pages are eventually closed outright.
  private async closeOverRetainedPages(): Promise<void> {
    const parked = this.pages.parked()
    const doomed = selectOffscreenBrowserPagesToClose(
      parked.map((page) => ({
        browserPageId: page.browserPageId,
        lastActivityAt: page.lastActivityAt,
        pinned: this.options.isPagePinned?.(page.browserPageId) === true
      })),
      this.pages.size,
      this.policy
    )
    for (const browserPageId of doomed) {
      console.warn(
        `[offscreen-browser] closing parked page ${browserPageId}: more than ${this.policy.retainedPageLimit} pages are open`
      )
      await this.closeTab(browserPageId)
    }
  }

  private async parkPage(browserPageId: string): Promise<void> {
    const page = this.pages.get(browserPageId)
    if (!page?.window || page.window.isDestroyed()) {
      return
    }
    // Why: capture the committed address before teardown so a woken page
    // returns to where the agent left it, not to its original create URL. A
    // page that never committed still reports the empty or blank address the
    // window started on; adopting that would send the wake to the wrong page.
    const wc = page.window.webContents
    const committed = wc.getURL()
    const uncommitted = !committed || committed === 'about:blank'
    if (!uncommitted && !committed.startsWith('chrome-error://')) {
      page.url = committed
    }
    page.title = wc.getTitle() ?? page.title
    page.activeWhenParked =
      this.options
        .getAgentBrowserBridge?.()
        ?.isActiveBrowserPage(browserPageId, page.worktreeId) === true
    await this.releaseRenderer(page, browserPageId)
    page.window = null
  }

  // Why: teardown order matters — the bridge must destroy the helper session and
  // detach its debugger while the WebContents is still alive and still mapped,
  // or the session, its CDP proxy and its listening port outlive the page.
  private async releaseRenderer(
    page: OffscreenBrowserPage | null,
    browserPageId: string
  ): Promise<void> {
    const pending = this.releasing.get(browserPageId)
    if (pending) {
      await pending
      return
    }
    const release = this.runReleaseRenderer(page, browserPageId)
    this.releasing.set(browserPageId, release)
    try {
      await release
    } finally {
      if (this.releasing.get(browserPageId) === release) {
        this.releasing.delete(browserPageId)
      }
    }
  }

  private async runReleaseRenderer(
    page: OffscreenBrowserPage | null,
    browserPageId: string
  ): Promise<void> {
    const bridge = this.options.getAgentBrowserBridge?.() ?? null
    const webContentsId = this.browserManager.getGuestWebContentsId(browserPageId)
    if (bridge && webContentsId != null) {
      await bridge.onTabClosed(webContentsId)
    }
    this.browserManager.unregisterGuest(browserPageId)
    if (page?.window && !page.window.isDestroyed()) {
      page.window.destroy()
    }
  }

  private materialize(page: OffscreenBrowserPage): void {
    const win = createOffscreenBrowserWindow(page.partition)
    page.window = win
    // Why: reading win.webContents once the contents are destroyed throws, and
    // the throw would escape the 'destroyed' listener into the main process.
    // Capture the id while it is still safe to read.
    const webContentsId = win.webContents.id
    // Why: if the window is destroyed out from under us (crash, app teardown),
    // drop the page so commands fail cleanly instead of resolving a dead
    // WebContents. Parking destroys it deliberately, so it opts out here.
    win.webContents.once('destroyed', () => {
      if (this.releasing.has(page.browserPageId) || page.window !== win) {
        return
      }
      this.pages.delete(page.browserPageId)
      // Why: an unprompted renderer loss must reclaim the helper session too, or
      // a crash loop leaks one session, CDP proxy and listening port per page —
      // the same leak the deliberate teardown path fixes.
      void this.options
        .getAgentBrowserBridge?.()
        ?.onTabClosed(webContentsId)
        .catch(() => {})
      this.browserManager.unregisterGuest(page.browserPageId)
      if (this.pages.size === 0) {
        this.stopSweep()
      }
    })
    const profile = page.profileId ? browserSessionRegistry.getProfile(page.profileId) : null
    this.browserManager.registerOffscreenGuest({
      browserPageId: page.browserPageId,
      worktreeId: page.worktreeId,
      sessionProfileId: page.profileId ?? null,
      userAgentMode: profile?.userAgentMode,
      webContentsId
    })
  }

  private async loadPage(page: OffscreenBrowserPage, url: string): Promise<void> {
    const win = page.window
    if (!win || win.isDestroyed()) {
      return
    }
    page.loading = true
    try {
      await loadOffscreenBrowserUrl(win, url)
    } finally {
      page.loading = false
    }
    if (page.window === win && !win.isDestroyed()) {
      page.title = win.webContents.getTitle() ?? page.title
      // Why: the reclaim clock must start when the page is ready, not when the
      // create call returned, or a slow load can be parked mid-flight.
      page.lastActivityAt = this.now()
    }
  }

  private ensureSweepScheduled(): void {
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
      const sweep = this.reclaimIdlePages().catch(() => {
        // A failed park is retried on the next sweep.
      })
      this.sweepInFlight = sweep
      void sweep.finally(() => {
        if (this.sweepInFlight === sweep) {
          this.sweepInFlight = null
        }
      })
    }, this.policy.sweepIntervalMs)
    // Why: reclamation must never be the reason the process stays alive.
    this.sweepTimer.unref?.()
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.sweepInFlight = null
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}
