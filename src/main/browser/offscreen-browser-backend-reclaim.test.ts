import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserManager } from './browser-manager'

const createOffscreenBrowserWindow = vi.fn<(partition: string) => unknown>()
const loadOffscreenBrowserUrl = vi.fn<(win: unknown, url: string) => Promise<void>>(async () => {})

vi.mock('./offscreen-browser-window', () => ({
  createOffscreenBrowserWindow: (partition: string) => createOffscreenBrowserWindow(partition),
  loadOffscreenBrowserUrl: (win: unknown, url: string) => loadOffscreenBrowserUrl(win, url)
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: (id: string) => ({ id, partition: `persist:${id}`, label: id }),
    getDefaultProfile: () => ({ id: 'default', partition: 'persist:default', label: 'Default' })
  }
}))

const { OffscreenBrowserBackend } = await import('./offscreen-browser-backend')

type FakeWindow = BrowserWindow & {
  __id: number
  __destroyed: boolean
  __url: string
  __destroyedListeners: (() => void)[]
  __navigationListeners: ((e: unknown, url: string) => void)[]
  navigateTo: (url: string) => void
}

let nextWebContentsId = 100

function makeWindow(): FakeWindow {
  const id = nextWebContentsId++
  const win = {
    __id: id,
    __destroyed: false,
    __url: 'about:blank',
    __destroyedListeners: [] as (() => void)[],
    __navigationListeners: [] as ((e: unknown, url: string) => void)[],
    isDestroyed: () => win.__destroyed,
    navigateTo: (url: string) => {
      win.__url = url
      for (const listener of win.__navigationListeners) {
        listener(null, url)
      }
    },
    destroy: () => {
      win.__destroyed = true
      for (const listener of win.__destroyedListeners) {
        listener()
      }
    },
    webContents: {
      id,
      isDestroyed: () => win.__destroyed,
      getURL: () => win.__url,
      getTitle: () => `title-${id}`,
      once: (event: string, listener: () => void) => {
        if (event === 'destroyed') {
          win.__destroyedListeners.push(listener)
        }
      },
      on: (event: string, listener: (e: unknown, url: string) => void) => {
        if (event === 'did-navigate' || event === 'did-navigate-in-page') {
          win.__navigationListeners.push(listener)
        }
      }
    }
  } as unknown as FakeWindow
  return win
}

type Harness = {
  backend: InstanceType<typeof OffscreenBrowserBackend>
  manager: BrowserManager
  bridge: AgentBrowserBridge
  order: string[]
  registered: Map<string, number>
  windows: FakeWindow[]
  clock: { value: number }
  activePageId: string | undefined
}

function createHarness(
  overrides: {
    pinned?: Set<string>
    activePageId?: string
    loadError?: { code: number; description: string; validatedUrl: string } | null
  } = {}
): Harness {
  const state = { activePageId: overrides.activePageId }
  const order: string[] = []
  const registered = new Map<string, number>()
  const windows: FakeWindow[] = []
  const clock = { value: 1_000_000 }

  createOffscreenBrowserWindow.mockImplementation(() => {
    const win = makeWindow()
    windows.push(win)
    return win
  })

  const manager = {
    registerOffscreenGuest: ({
      browserPageId,
      webContentsId
    }: {
      browserPageId: string
      webContentsId: number
    }) => {
      order.push(`register:${browserPageId}:${webContentsId}`)
      registered.set(browserPageId, webContentsId)
    },
    unregisterGuest: (browserPageId: string) => {
      order.push(`unregister:${browserPageId}`)
      registered.delete(browserPageId)
    },
    getGuestWebContentsId: (browserPageId: string) => registered.get(browserPageId) ?? null,
    getBrowserPageLoadError: () => overrides.loadError ?? null
  } as unknown as BrowserManager

  const bridge = {
    onTabClosed: vi.fn(async (webContentsId: number) => {
      order.push(`session-destroy:${webContentsId}`)
    }),
    onProcessSwap: vi.fn(async (browserPageId: string, webContentsId: number) => {
      order.push(`process-swap:${browserPageId}:${webContentsId}`)
    }),
    isActiveBrowserPage: (browserPageId: string) => state.activePageId === browserPageId
  } as unknown as AgentBrowserBridge

  const backend = new OffscreenBrowserBackend(manager, {
    getAgentBrowserBridge: () => bridge,
    isPagePinned: (id) => overrides.pinned?.has(id) === true,
    now: () => clock.value
  })

  return {
    backend,
    manager,
    bridge,
    order,
    registered,
    windows,
    clock,
    set activePageId(value: string | undefined) {
      state.activePageId = value
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  nextWebContentsId = 100
  process.env.ORCA_HEADLESS_BROWSER_RESIDENT_LIMIT = '2'
  process.env.ORCA_HEADLESS_BROWSER_PARK_IDLE_MS = '60000'
  process.env.ORCA_HEADLESS_BROWSER_PARK_GRACE_MS = '5000'
  process.env.ORCA_HEADLESS_BROWSER_PARK_SWEEP_MS = '100000'
  process.env.ORCA_HEADLESS_BROWSER_MAX_RETAINED_PAGES = '100'
})

describe('OffscreenBrowserBackend reclamation', () => {
  it('parks an idle page: renderer destroyed, page kept and listed', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]

    h.clock.value += 120_000
    expect(await h.backend.reclaimIdlePages()).toEqual([pageId])

    expect(h.windows[0].isDestroyed()).toBe(true)
    expect(h.registered.has(pageId)).toBe(false)
    expect(h.backend.listParkedPages()).toEqual([
      {
        browserPageId: pageId,
        worktreeId: undefined,
        profileId: 'default',
        url: 'https://example.test/a',
        title: `title-${h.windows[0].webContents.id}`,
        active: false,
        loadError: null
      }
    ])
  })

  it('tears the helper session down before the mapping and the renderer go away', async () => {
    // Why (STA-4341): the headless close path used to skip the bridge entirely,
    // so every closed page left its agent-browser session and CDP proxy behind.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.order.length = 0

    await h.backend.closeTab(pageId)

    expect(h.order).toEqual([
      `session-destroy:${h.windows[0].webContents.id}`,
      `unregister:${pageId}`
    ])
    expect(h.windows[0].isDestroyed()).toBe(true)
  })

  it('tears the helper session down when parking too', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.order.length = 0

    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.order).toEqual([
      `session-destroy:${h.windows[0].webContents.id}`,
      `unregister:${pageId}`
    ])
  })

  it('wakes a parked page under the same id and reloads where it left off', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.windows[0].navigateTo('https://example.test/moved')

    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    h.order.length = 0
    loadOffscreenBrowserUrl.mockClear()

    expect(await h.backend.wakeTab(pageId)).toBe(true)

    const wokenId = h.windows[1].webContents.id
    expect(h.windows).toHaveLength(2)
    expect(h.registered.get(pageId)).toBe(wokenId)
    expect(h.order).toEqual([`register:${pageId}:${wokenId}`, `process-swap:${pageId}:${wokenId}`])
    expect(loadOffscreenBrowserUrl).toHaveBeenCalledWith(h.windows[1], 'https://example.test/moved')
    expect(h.backend.listParkedPages()).toEqual([])
  })

  it('keeps the requested address when a page parks before committing one', async () => {
    // Why: a page whose load never committed must still wake to the address the
    // agent asked for, not to the blank page the window started on.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/slow', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.url).toBe('https://example.test/slow')
  })

  it('never parks a page whose navigation is still in flight', async () => {
    let finishLoad = (): void => {}
    loadOffscreenBrowserUrl.mockImplementationOnce(
      async () => new Promise<void>((resolve) => (finishLoad = resolve))
    )
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/slow', browserPageId: 'a' })

    h.clock.value += 120_000
    expect(await h.backend.reclaimIdlePages()).toEqual([])

    finishLoad()
    await Promise.resolve()
    await Promise.resolve()
    h.clock.value += 120_000
    expect(await h.backend.reclaimIdlePages()).toEqual(['a'])
  })

  it('coalesces concurrent wakes into one renderer', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a' })
    const [pageId] = [...h.registered.keys()]
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const [first, second] = await Promise.all([
      h.backend.wakeTab(pageId),
      h.backend.wakeTab(pageId)
    ])

    expect([first, second]).toEqual([true, true])
    expect(h.windows).toHaveLength(2)
  })

  it('owns no page and no renderer when materialization fails', async () => {
    // Why: a create that never produced a usable renderer must not occupy the
    // retention budget, be listed as parked, or block a retry with the same id.
    const h = createHarness()
    h.manager.registerOffscreenGuest = () => {
      throw new Error('register failed')
    }

    await expect(h.backend.createTab({ url: 'https://a', browserPageId: 'a' })).rejects.toThrow(
      'register failed'
    )

    expect(h.backend.listParkedPages()).toEqual([])
    expect(h.windows.every((win) => win.isDestroyed())).toBe(true)
    // The id is free again, so a retry is not rejected as already existing.
    h.manager.registerOffscreenGuest = (({
      browserPageId,
      webContentsId
    }: {
      browserPageId: string
      webContentsId: number
    }) => {
      h.registered.set(browserPageId, webContentsId)
    }) as typeof h.manager.registerOffscreenGuest
    await expect(h.backend.createTab({ url: 'https://a', browserPageId: 'a' })).resolves.toEqual({
      browserPageId: 'a'
    })
  })

  it('reports false when waking a page it does not own', async () => {
    const h = createHarness()
    expect(await h.backend.wakeTab('nope')).toBe(false)
  })

  it('does not park a pinned page even when it is the oldest', async () => {
    const h = createHarness({ pinned: new Set(['streamed']) })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'streamed' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'idle' })
    h.clock.value += 120_000

    expect(await h.backend.reclaimIdlePages()).toEqual(['idle'])
  })

  it('keeps the resident cap by evicting least-recently-used pages', async () => {
    const h = createHarness()
    for (const id of ['a', 'b', 'c', 'd']) {
      await h.backend.createTab({ url: `https://example.test/${id}`, browserPageId: id })
      h.clock.value += 1_000
    }
    // Why: past the grace floor but well inside the idle window, so the cap is
    // provably the evictor here.
    h.clock.value += 10_000

    expect(await h.backend.reclaimIdlePages()).toEqual(['a', 'b'])
    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['a', 'b'])
  })

  it('remembers whether a page was active when it parked, and forgets on wake', async () => {
    // Why: the paired client's tab bar reads the session snapshot; a park must
    // not silently deselect the tab the user had open.
    const h = createHarness({ activePageId: 'a' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(
      h.backend.listParkedPages().map((page) => [page.browserPageId, page.active === true])
    ).toEqual([
      ['a', true],
      ['b', false]
    ])

    await h.backend.wakeTab('a')
    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['b'])
  })

  it('keeps an intentional navigation to about:blank across a park', async () => {
    // Why: an in-page `location.href = "about:blank"` is a real destination.
    // Sniffing the address at park time could not tell it apart from the blank
    // page a window starts on, so the record follows navigation instead.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.windows[0].navigateTo('about:blank')
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.url).toBe('about:blank')
  })

  it('ignores a chrome-error address so a wake retries the real one', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.windows[0].navigateTo('chrome-error://chromewebdata/')
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.url).toBe('https://example.test/a')
  })

  it('carries a load failure onto the parked record', async () => {
    // Why: reclaiming a renderer does not make a page that failed to load
    // healthy, and the failure is unreadable once the guest is unregistered.
    const loadError = { code: -105, description: 'NAME_NOT_RESOLVED', validatedUrl: 'https://nope' }
    const h = createHarness({ loadError })
    await h.backend.createTab({ url: 'https://nope', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages()[0]?.loadError).toEqual(loadError)
  })

  it('lets only the newest claim hold the parked active flag', async () => {
    // Why: parking the active page promotes another live tab to active, which
    // then parks claiming the flag too. `active` is a single selection.
    const h = createHarness({ activePageId: 'a' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-1' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()
    // Simulate the promotion: b is now the active page and parks claiming it.
    h.activePageId = 'b'
    await h.backend.wakeTab('b')
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    const claimed = h.backend.listParkedPages().filter((page) => page.active)
    expect(claimed.map((page) => page.browserPageId)).toEqual(['b'])
  })

  it('targets the page that was active, not merely the most recently used', async () => {
    // Why: an explicit `--page b` command makes b the most recently used while
    // a is still the active tab, and a page-less command means "the active tab".
    const h = createHarness({ activePageId: 'a' })
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-1' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.getParkedPageIdForImplicitTarget('wt-1')).toBe('a')
  })

  it('reports the most recently used parked page for implicit targeting', async () => {
    const h = createHarness()
    for (const id of ['a', 'b', 'c', 'd']) {
      await h.backend.createTab({ url: `https://example.test/${id}`, browserPageId: id })
      h.clock.value += 1_000
    }
    h.clock.value += 10_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.getParkedPageIdForImplicitTarget()).toBe('b')
  })

  it('restarts the reclaim clock when a resident page is used', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.clock.value += 120_000

    // Why: waking a resident page must not rebuild its renderer, only mark it used.
    expect(await h.backend.wakeTab('a')).toBe(true)
    expect(h.windows).toHaveLength(1)
    expect(await h.backend.reclaimIdlePages()).toEqual([])
  })

  it('does not let a command land on a renderer that a park is tearing down', async () => {
    let releaseSession = (): void => {}
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    const bridge = h.bridge as unknown as { onTabClosed: ReturnType<typeof vi.fn> }
    bridge.onTabClosed.mockImplementation(
      async () => new Promise<void>((resolve) => (releaseSession = resolve))
    )

    h.clock.value += 120_000
    const park = h.backend.reclaimIdlePages()
    const wake = h.backend.wakeTab('a')
    releaseSession()
    await park
    expect(await wake).toBe(true)

    // The woken renderer is a fresh one, not the window the park destroyed.
    expect(h.windows).toHaveLength(2)
    expect(h.windows[0].isDestroyed()).toBe(true)
    expect(h.windows[1].isDestroyed()).toBe(false)
    expect(h.registered.get('a')).toBe(h.windows[1].webContents.id)
  })

  it('keeps a parked page after its renderer emits destroyed', async () => {
    // Why: parking destroys the window on purpose; the crash handler must not
    // read that as the page going away or the record is lost.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['a'])
  })

  it('drops a page whose renderer dies on its own and reclaims its helper session', async () => {
    // Why: without this the crash path leaks one helper session, CDP proxy and
    // listening port per lost renderer — a crash loop is unbounded.
    const h = createHarness()
    await h.backend.createTab({ url: 'https://example.test/a', browserPageId: 'a' })
    const webContentsId = h.windows[0].webContents.id
    h.order.length = 0

    h.windows[0].destroy()
    await Promise.resolve()

    expect(h.order).toEqual([`session-destroy:${webContentsId}`, 'unregister:a'])
    expect(h.backend.listParkedPages()).toEqual([])
    expect(await h.backend.wakeTab('a')).toBe(false)
  })

  it('closes the oldest parked pages once too many records are retained', async () => {
    // Why: parking bounds renderer processes, not the page records behind them.
    process.env.ORCA_HEADLESS_BROWSER_MAX_RETAINED_PAGES = '2'
    const h = createHarness()
    for (const id of ['a', 'b', 'c', 'd']) {
      await h.backend.createTab({ url: `https://example.test/${id}`, browserPageId: id })
      h.clock.value += 1_000
    }
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages().map((page) => page.browserPageId)).toEqual(['c', 'd'])
    expect(h.windows.every((win) => win.isDestroyed())).toBe(true)
  })

  it('scopes parked listings and implicit targeting to a worktree', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a', worktreeId: 'wt-1' })
    h.clock.value += 1_000
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b', worktreeId: 'wt-2' })
    h.clock.value += 120_000
    await h.backend.reclaimIdlePages()

    expect(h.backend.listParkedPages('wt-1').map((page) => page.browserPageId)).toEqual(['a'])
    expect(h.backend.getParkedPageIdForImplicitTarget('wt-2')).toBe('b')
  })

  it('destroys every page it owns on shutdown', async () => {
    const h = createHarness()
    await h.backend.createTab({ url: 'https://a', browserPageId: 'a' })
    await h.backend.createTab({ url: 'https://b', browserPageId: 'b' })

    h.backend.destroyAll()

    expect(h.windows.every((win) => win.isDestroyed())).toBe(true)
    expect(h.backend.listParkedPages()).toEqual([])
  })
})
