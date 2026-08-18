import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
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
  /** Called when the set of open pages changes, so paired clients republish. */
  onPagesChanged?: (worktreeId: string | undefined) => void
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
    // Why: closing drops the record before its teardown finishes, so a caller
    // reusing the id can register a new renderer that the old close then
    // unregisters. Let the release finish before claiming the id again.
    await this.releasing.get(browserPageId)
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
      loadError: null,
      lastActivityAt: this.now()
    }
    this.pages.add(page)
    try {
      // Why: register the guest and return immediately so the new tab appears
      // without waiting for the page to finish loading. A failed load leaves
      // the (usable) tab open, matching how a normal browser tab survives one.
      this.materialize(page)
    } catch (error) {
      // Why: a create that never produced a usable renderer must not become an
      // owned page. Left in place it would occupy the retention budget, be
      // listed as parked, and make a retry with the same id fail as "already
      // exists" — while never having installed the crash handler that would
      // have cleaned it up.
      this.pages.delete(browserPageId)
      throw error
    }
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
    // Why: closing a parked page has no WebContents teardown to piggyback on,
    // so nothing else tells paired clients the tab is gone — they would keep
    // showing a ghost until an operation against it failed.
    if (page) {
      this.options.onPagesChanged?.(page.worktreeId)
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
    // Why: a wake materializes the window before it swaps the helper session
    // and reloads the address, so the page looks resident well before it is
    // usable. Join an in-flight wake first or a second command runs against a
    // blank page whose session is still being torn down underneath it.
    const inFlight = this.waking.get(browserPageId)
    if (inFlight) {
      return inFlight
    }
    const releasing = this.releasing.get(browserPageId)
    if (!releasing && page.window && !page.window.isDestroyed()) {
      return true
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

  /** The parked page a page-less command should target in this worktree. */
  getParkedPageIdForImplicitTarget(worktreeId?: string): string | null {
    return this.pages.parkedIdForImplicitTarget(worktreeId)
  }

  // Why: quit only. The bridge's own destroyAllSessions() runs immediately
  // before this in the shutdown chain, so routing each page through the bridge
  // again would only re-close sessions that are already gone.
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
    const resident = this.pages.resident().filter((page) => !this.releasing.has(page.browserPageId))
    const doomed = selectOffscreenBrowserPagesToPark(
      resident.map((page) => this.toReclaimCandidate(page)),
      this.now(),
      this.policy
    )
    const parked: string[] = []
    for (const browserPageId of doomed) {
      // Why: parking awaits the helper session's teardown, so a page later in
      // this list can be woken and driven while an earlier one is still being
      // torn down. The selection is a proposal, not a licence — re-check each
      // page against the live state before destroying its renderer.
      if (!this.isSafeToReclaim(browserPageId)) {
        continue
      }
      await this.parkPage(browserPageId)
      parked.push(browserPageId)
    }
    await this.closeOverRetainedPages()
    return parked
  }

  // Why: parking bounds renderer processes, not the records behind them. An
  // agent that opens pages forever and closes none would still grow the backend
  // without limit, so the oldest parked pages are eventually closed outright.
  private async closeOverRetainedPages(): Promise<void> {
    const doomed = selectOffscreenBrowserPagesToClose(
      this.pages.parked().map((page) => this.toReclaimCandidate(page)),
      this.pages.size,
      this.policy
    )
    for (const browserPageId of doomed) {
      // Why: closing is destructive and awaits teardown, so a page selected
      // here can be woken before its turn comes. Only close one that is still
      // parked and still unwanted.
      const page = this.pages.get(browserPageId)
      if (!page || page.window || !this.isSafeToReclaim(browserPageId)) {
        continue
      }
      console.warn(
        `[offscreen-browser] closing parked page ${browserPageId}: more than ${this.policy.retainedPageLimit} pages are open`
      )
      await this.closeTab(browserPageId)
    }
  }

  private toReclaimCandidate(page: OffscreenBrowserPage): {
    browserPageId: string
    lastActivityAt: number
    pinned: boolean
  } {
    return {
      browserPageId: page.browserPageId,
      lastActivityAt: page.lastActivityAt,
      pinned: this.isPagePinned(page)
    }
  }

  // Why: a page is off limits while anything is depending on its renderer —
  // a client streaming it, a command in flight, its first navigation still
  // committing, or a wake still rebuilding it. The wake case matters because a
  // wake is resident but not yet loading while it awaits the process swap.
  private isPagePinned(page: OffscreenBrowserPage): boolean {
    return (
      page.loading ||
      this.isNavigating(page) ||
      this.waking.has(page.browserPageId) ||
      // Why: a page blocked on a certificate decision is work waiting on an
      // answer. Its challenge id dies with the renderer, so parking it would
      // discard both the warning and the ability to approve it.
      this.browserManager.getBrowserPageCertificateFailure(page.browserPageId) !== null ||
      this.options.isPagePinned?.(page.browserPageId) === true
    )
  }

  // Why: the load helper resolves on its own timeout, so `loading` stops
  // covering a navigation that is slow rather than finished. Ask the renderer.
  private isNavigating(page: OffscreenBrowserPage): boolean {
    const win = page.window
    if (!win || win.isDestroyed()) {
      return false
    }
    try {
      return win.webContents.isLoading()
    } catch {
      return false
    }
  }

  private isSafeToReclaim(browserPageId: string): boolean {
    const page = this.pages.get(browserPageId)
    if (!page || this.releasing.has(browserPageId)) {
      return false
    }
    return !this.isPagePinned(page) && this.now() - page.lastActivityAt >= this.policy.parkGraceMs
  }

  private async parkPage(browserPageId: string): Promise<void> {
    const page = this.pages.get(browserPageId)
    if (!page?.window || page.window.isDestroyed()) {
      return
    }
    // Why: the record's address is kept current by did-navigate, so parking
    // never has to guess it from a WebContents that may be sitting on the blank
    // page a failed load left behind.
    page.title = page.window.webContents.getTitle() ?? page.title
    // Why: a reclaimed renderer does not make a page that failed to load
    // healthy, and the failure becomes unreadable once the guest is
    // unregistered — so carry it onto the record.
    page.loadError = this.browserManager.getBrowserPageLoadError(browserPageId)
    page.activeWhenParked =
      this.options
        .getAgentBrowserBridge?.()
        ?.isActiveBrowserPage(browserPageId, page.worktreeId) === true
    await this.releaseRenderer(page, browserPageId)
    page.window = null
    if (page.activeWhenParked) {
      // Why: teardown promotes another live tab to active, which then parks
      // claiming the flag too. Only the newest claim may hold it.
      this.pages.claimParkedActive(browserPageId, page.worktreeId)
    }
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
    try {
      this.attachWindow(page, win)
    } catch (error) {
      // Why: the window exists before anything that can fail. Abandoning it
      // here would leak a hidden renderer nothing owns or can reach.
      page.window = null
      if (!win.isDestroyed()) {
        win.destroy()
      }
      throw error
    }
  }

  private attachWindow(page: OffscreenBrowserPage, win: BrowserWindow): void {
    page.window = win
    // Why: reading win.webContents once the contents are destroyed throws, and
    // the throw would escape the 'destroyed' listener into the main process.
    // Capture the id while it is still safe to read.
    const webContentsId = win.webContents.id
    // Why: the record's address must follow the page, not the create call — an
    // agent that navigates with `goto` or in-page script has to be woken back
    // to where it actually is. A chrome-error address is the failure, not a
    // destination, so it never replaces the address that produced it.
    const recordAddress = (url: string): void => {
      if (page.window === win && url && !url.startsWith('chrome-error://')) {
        page.url = url
      }
    }
    // did-navigate is main-frame only; did-frame-navigate covers subframes.
    win.webContents.on('did-navigate', (_event, url) => recordAddress(url))
    // Why: an iframe changing its own hash also fires did-navigate-in-page. A
    // subframe navigation is not a navigation of the tab, and adopting its
    // address would wake the page onto the iframe's document.
    win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) {
        recordAddress(url)
      }
    })
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
