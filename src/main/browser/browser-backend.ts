// Why: browser pages can be backed two ways. A desktop renderer mounts an
// Electron <webview> (renderer backend). A headless orca serve has no renderer
// window, so it backs pages with main-process offscreen WebContents (offscreen
// backend). Both register the page's WebContents into BrowserManager, so every
// downstream command (agent-browser automation, screencast, input) resolves a
// WebContents uniformly regardless of how the page was created. This interface
// isolates the only step that actually differs: tab creation and teardown.

export type BrowserBackendCreateTab = {
  url: string
  worktreeId?: string
  profileId?: string
  browserPageId?: string
}

/** A page whose renderer has been reclaimed but whose identity is retained. */
export type ParkedBrowserPage = {
  browserPageId: string
  worktreeId?: string
  profileId?: string
  url: string
  title: string
}

export type BrowserBackend = {
  /** Create a browser page and register its WebContents. Returns the page id. */
  createTab(params: BrowserBackendCreateTab): Promise<{ browserPageId: string }>
  /** Tear down a browser page created by this backend. */
  closeTab(browserPageId: string): Promise<void>
  /** Tear down every page this backend owns (process shutdown). Optional —
   *  renderer-hosted backends are torn down with their window. */
  destroyAll?(): void
  /** Make a page's renderer resident and restart its reclaim clock. Cheap and
   *  idempotent for an already-resident page, so command routing calls it
   *  unconditionally. Resolves false when the page id is unknown. Optional —
   *  only the offscreen backend owns renderer lifetime; renderer-hosted pages
   *  are parked by the window that hosts them. */
  wakeTab?(browserPageId: string): Promise<boolean>
  /** Pages this backend still owns whose renderer is currently reclaimed. */
  listParkedPages?(worktreeId?: string): ParkedBrowserPage[]
  /** Most-recently-used parked page, for commands that target a worktree
   *  rather than a page id. */
  getMostRecentlyUsedParkedPageId?(worktreeId?: string): string | null
}
