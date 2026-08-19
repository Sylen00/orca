import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrcaRuntimeService as RealOrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  handleByPtyId: Map<string, string>
  waitersByHandle: Map<string, Set<unknown>>
  graphStatus: string
  authoritativeWindowId: number | null
  rendererGraphEpoch: number
  handles: Map<string, unknown>
  leaves: Map<string, unknown>
}

const settleOutcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: Error) => `rejected:${error.message}`
  )

function seedGraphBackedTerminal(runtime: RealOrcaRuntimeService, handle: string): void {
  const internals = runtime as unknown as RuntimeInternals
  internals.graphStatus = 'ready'
  internals.authoritativeWindowId = 1
  internals.rendererGraphEpoch = 1
  internals.handles.set(handle, {
    handle,
    runtimeId: runtime.getRuntimeId(),
    rendererGraphEpoch: 1,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-graph',
    ptyGeneration: 1
  })
  // Why: connected must be true with a null exit code, or getTerminalState reads 'exited'
  // and the waiter resolves for the wrong reason.
  internals.leaves.set('tab-1::leaf-1', {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-graph',
    ptyGeneration: 1,
    worktreeId: 'wt-1',
    connected: true,
    lastExitCode: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: ''
  })
}

type SubscribeHarness = {
  runtime: OrcaRuntimeService
  messages: string[]
  jsonTypes: () => (string | undefined)[]
  binaryFrames: Uint8Array[]
  waitForTerminal: ReturnType<typeof vi.fn>
  dispatch: (overrides?: Partial<RpcRequest['params']>) => Promise<void>
}

function createSubscribeHarness(
  waitForTerminal: ReturnType<typeof vi.fn>,
  options?: { capabilities?: Record<string, number> }
): SubscribeHarness {
  const registry = createSubscriptionRegistryDouble()
  const messages: string[] = []
  const binaryFrames: Uint8Array[] = []
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    getRendererTerminalSerializerGenerationForHandle: () => 0,
    getRendererTerminalSerializerGeneration: () => 0,
    waitForRendererTerminalSerializer: async () => false,
    getPtyOutputSequence: () => 0,
    replaceHeadlessTerminalFromRendererSnapshotForRecovery: () => {},
    serializeRendererTerminalBuffer: async () => null,
    hasHeadlessTerminalState: () => true,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    unregisterRemoteDesktopViewer: vi.fn(),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: ['hello world'], truncated: false }),
    serializeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'REAL SCROLLBACK', cols: 80, rows: 24, seq: 4 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

  return {
    runtime,
    messages,
    binaryFrames,
    waitForTerminal,
    jsonTypes: () => messages.map((message) => JSON.parse(message).result?.type),
    dispatch: (overrides) =>
      dispatcher.dispatchStreaming(
        {
          id: 'req-1',
          authToken: 'tok',
          method: 'terminal.subscribe',
          params: {
            terminal: 'terminal-1',
            client: { id: 'phone-1', type: 'mobile' },
            viewport: { cols: 40, rows: 20 },
            capabilities: { terminalBinaryStream: 1, ...options?.capabilities },
            ...overrides
          }
        } as RpcRequest,
        (message) => messages.push(message),
        {
          connectionId: 'conn-phone',
          sendBinary: (bytes: Uint8Array) => {
            binaryFrames.push(bytes)
          },
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        }
      )
  }
}

const staleForever = (): ReturnType<typeof vi.fn> =>
  vi.fn(() => Promise.reject(new Error('terminal_handle_stale')))

afterEach(() => {
  vi.useRealTimers()
})

describe('runtime exit-waiter rejection on graph churn', () => {
  it('rejects an outstanding exit-waiter when the desktop window closes', async () => {
    const runtime = new RealOrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    internals.recordPtyWorktree('pty-live', 'wt-live', { connected: true })
    internals.handleByPtyId.set('pty-live', 'handle-live')
    runtime.attachWindow(1)

    const settled = settleOutcome(runtime.waitForTerminal('handle-live', { condition: 'exit' }))
    await Promise.resolve()
    expect(internals.waitersByHandle.get('handle-live')?.size ?? 0).toBe(1)

    runtime.markGraphUnavailable(1)

    expect(await settled).toBe('rejected:terminal_handle_stale')
  })

  it('rejects an outstanding exit-waiter when the renderer reloads', async () => {
    const runtime = new RealOrcaRuntimeService()
    const internals = runtime as unknown as RuntimeInternals
    seedGraphBackedTerminal(runtime, 'handle-graph')

    const settled = settleOutcome(runtime.waitForTerminal('handle-graph', { condition: 'exit' }))
    await Promise.resolve()
    expect(internals.waitersByHandle.get('handle-graph')?.size ?? 0).toBe(1)

    expect(runtime.markRendererReloading(1)).not.toBeNull()

    expect(await settled).toBe('rejected:terminal_handle_stale')
  })

  it('rejects a re-armed exit-waiter with runtime_unavailable while the graph is down', async () => {
    const runtime = new RealOrcaRuntimeService()
    seedGraphBackedTerminal(runtime, 'handle-graph')
    runtime.markRendererReloading(1)

    expect(
      await settleOutcome(runtime.waitForTerminal('handle-graph', { condition: 'exit' }))
    ).toBe('rejected:runtime_unavailable')
  })
})

describe('terminal.subscribe survives a stale exit-waiter rejection', () => {
  it('keeps the mobile binary view stream alive and still delivers its snapshot', async () => {
    const harness = createSubscribeHarness(staleForever())
    void harness.dispatch()

    await vi.waitFor(() => expect(harness.binaryFrames.length).toBeGreaterThan(0))
    expect(harness.jsonTypes()).toContain('subscribed')
    expect(harness.jsonTypes()).not.toContain('end')
  })

  it('keeps the lease-only chat stream alive', async () => {
    const harness = createSubscribeHarness(staleForever(), {
      capabilities: { mobileInputLeaseOnly: 1 }
    })
    void harness.dispatch()

    await vi.waitFor(() => expect(harness.jsonTypes()).toContain('subscribed'))
    expect(harness.jsonTypes()).not.toContain('end')
  })

  it('keeps the JSON stream alive', async () => {
    const harness = createSubscribeHarness(staleForever())
    void harness.dispatch({
      client: { id: 'desk-1', type: 'desktop' },
      viewport: undefined,
      capabilities: {}
    } as Partial<RpcRequest['params']>)

    await vi.waitFor(() => expect(harness.jsonTypes()).toContain('scrollback'))
    expect(harness.jsonTypes()).not.toContain('end')
  })

  it('re-arms after a stale rejection so a later real exit still ends the stream', async () => {
    let resolveExit = (_wait: RuntimeTerminalWait): void => {}
    const waitForTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error('terminal_handle_stale'))
      .mockImplementationOnce(
        () =>
          new Promise<RuntimeTerminalWait>((resolve) => {
            resolveExit = resolve
          })
      )
    const harness = createSubscribeHarness(waitForTerminal)
    void harness.dispatch()

    await vi.waitFor(() => expect(harness.jsonTypes()).toContain('subscribed'))
    await vi.waitFor(() => expect(waitForTerminal).toHaveBeenCalledTimes(2))
    expect(harness.jsonTypes()).not.toContain('end')

    resolveExit({ handle: 'terminal-1', condition: 'exit' } as unknown as RuntimeTerminalWait)

    await vi.waitFor(() => expect(harness.jsonTypes()).toContain('end'))
  })

  it('still ends the stream when the terminal genuinely exits', async () => {
    const harness = createSubscribeHarness(
      vi.fn(() =>
        Promise.resolve({
          handle: 'terminal-1',
          condition: 'exit'
        } as unknown as RuntimeTerminalWait)
      )
    )
    void harness.dispatch()

    await vi.waitFor(() => expect(harness.jsonTypes()).toContain('end'))
    expect(harness.waitForTerminal).toHaveBeenCalledTimes(1)
  })

  it('still ends the stream when the waiter fails for a reason other than an unresolvable handle', async () => {
    const waitForTerminal = vi.fn(() => Promise.reject(new Error('request_aborted')))
    const harness = createSubscribeHarness(waitForTerminal)
    void harness.dispatch()

    await vi.waitFor(() => expect(harness.jsonTypes()).toContain('end'))
    expect(waitForTerminal).toHaveBeenCalledTimes(1)
  })
})
