import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import type { setFitOverride as SetFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({ scheduleTerminalWebglAtlasRecovery }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({ shouldSeedCacheTimerOnInitialTitle }))

vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getEagerPtyBufferHandle: vi.fn(() => undefined) }
})

const PHONE = { cols: 45, rows: 20 }
const DESKTOP = { cols: 120, rows: 40 }
// The pty id the store fixture binds to this tab's pane.
const PTY_ID = 'tab-pty'

/** Mirrors the real fit: proposeDimensions reports the desktop box, and a fit
 *  moves xterm's grid onto it. The mobile-fit hold parks it at phone dims. */
function makeDesktopFittingPane(paneId: number): MockPane {
  const pane = createPane(paneId)
  pane.fitAddon.proposeDimensions.mockImplementation(() => DESKTOP)
  pane.fitAddon.fit.mockImplementation(() => {
    pane.terminal.cols = DESKTOP.cols
    pane.terminal.rows = DESKTOP.rows
  })
  return pane
}

async function connectPaneHoldingMobileFit(ptyId: string = PTY_ID): Promise<{
  pane: MockPane
  signalPty: ReturnType<typeof vi.fn>
  setFitOverride: typeof SetFitOverride
  dispose: () => void
}> {
  const { connectPanePty } = await import('./pty-connection')
  // Why: vi.resetModules() gives every test a fresh module graph, so the override
  // emitter must be resolved from the same one connectPanePty subscribes to.
  const { setFitOverride } = await import('@/lib/pane-manager/mobile-fit-overrides')
  const transport = createMockTransport(ptyId)
  transport.getPtyId.mockReturnValue(ptyId)
  transportFactoryQueue.push(transport)
  const pane = makeDesktopFittingPane(1)
  const manager = createManager(1)
  const deps = buildPaneConnectionDeps(() => mockStoreState, { isVisibleRef: { current: true } })
  const disposable = connectPanePty(pane as never, manager as never, deps as never)
  await flushAsyncTicks(6)

  // The phone takes the floor: the host parks the PTY and xterm at phone dims.
  setFitOverride(ptyId, 'mobile-fit', PHONE.cols, PHONE.rows)
  pane.terminal.cols = PHONE.cols
  pane.terminal.rows = PHONE.rows
  await flushAsyncTicks(2)

  const signalPty = window.api.pty.signal as unknown as ReturnType<typeof vi.fn>
  signalPty.mockClear()
  return { pane, signalPty, setFitOverride, dispose: () => disposable.dispose() }
}

describe('mobile-fit release repaint', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('signals SIGWINCH once the restored desktop grid lands so the TUI repaints', async () => {
    const { pane, signalPty, setFitOverride, dispose } = await connectPaneHoldingMobileFit()

    setFitOverride(PTY_ID, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
    await flushAsyncTicks(6)

    expect({
      cols: pane.terminal.cols,
      rows: pane.terminal.rows,
      signals: signalPty.mock.calls
    }).toEqual({
      cols: DESKTOP.cols,
      rows: DESKTOP.rows,
      signals: [[PTY_ID, 'SIGWINCH']]
    })
    dispose()
  })

  it('does not repaint-signal when another desktop takes the grid instead', async () => {
    const { signalPty, setFitOverride, dispose } = await connectPaneHoldingMobileFit()

    setFitOverride(PTY_ID, 'remote-desktop-fit', 100, 30)
    await flushAsyncTicks(6)

    expect(signalPty.mock.calls).toEqual([])
    setFitOverride(PTY_ID, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
    dispose()
  })

  it('repaint-signals only the hold it released, not every desktop-fit', async () => {
    const { signalPty, setFitOverride, dispose } = await connectPaneHoldingMobileFit()

    setFitOverride(PTY_ID, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
    // A pty exit re-emits desktop-fit for an id that holds nothing (0x0).
    setFitOverride(PTY_ID, 'desktop-fit', 0, 0)
    await flushAsyncTicks(6)

    expect(signalPty.mock.calls).toEqual([[PTY_ID, 'SIGWINCH']])
    dispose()
  })

  it('does not repaint-signal a remote runtime pty, which has no signal channel', async () => {
    const remotePtyId = 'remote:env-1@@terminal-1'
    const { signalPty, setFitOverride, dispose } = await connectPaneHoldingMobileFit(remotePtyId)

    setFitOverride(remotePtyId, 'desktop-fit', DESKTOP.cols, DESKTOP.rows)
    await flushAsyncTicks(6)

    expect(signalPty.mock.calls).toEqual([])
    dispose()
  })
})
