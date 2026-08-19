import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// STA-4823: six shared Codex state files were rebuilt, erased or reported as
// healthy after a read that had merely failed. Every one is reachable on the
// host lane; the WSL-specific half of the catalogue stays in STA-4606.

const denials = vi.hoisted(() => {
  const state = {
    paths: new Set<string>(),
    readOnlyPaths: new Set<string>(),
    existenceDeniedPaths: new Set<string>(),
    deny(path: string): void {
      state.paths.add(path)
    },
    /**
     * Content reads fail but `existsSync` still says the file is there — the
     * shape a Windows sharing violation takes, as distinct from `deny`, which
     * models an ACL denial where `existsSync` itself reports false.
     */
    denyReads(path: string): void {
      state.readOnlyPaths.add(path)
    },
    /**
     * `existsSync` reports false and content reads throw, but `statSync` and the
     * atomic replace still work. This is the shape that actually loses data: the
     * caller concludes "no file here", builds fresh content, and the rename
     * lands because rename needs permission on the DIRECTORY, not the target.
     * Guarding the write as well would let a test pass because the write failed
     * rather than because the fix refused.
     */
    denyExistence(path: string): void {
      state.existenceDeniedPaths.add(path)
    },
    release(path: string): void {
      state.paths.delete(path)
    },
    reset(): void {
      state.paths.clear()
      state.readOnlyPaths.clear()
      state.existenceDeniedPaths.clear()
    },
    check(target: unknown, syscall: string, readOnly = false): void {
      if (typeof target !== 'string') {
        return
      }
      const readDenied =
        readOnly && (state.readOnlyPaths.has(target) || state.existenceDeniedPaths.has(target))
      if (!state.paths.has(target) && !readDenied) {
        return
      }
      const error: NodeJS.ErrnoException = new Error(
        `EPERM: operation not permitted, ${syscall} '${target}'`
      )
      error.code = 'EPERM'
      error.errno = -4048
      error.syscall = syscall
      error.path = target
      throw error
    }
  }
  return state
})

// One denial modelled coherently: a denied path throws from every read AND
// reports false from existsSync. Faulting one but not another lets a test pass
// against code that still consults the one left healthy.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const guard = (fn: unknown, syscall: string): unknown => {
    const original = fn as (...args: unknown[]) => unknown
    const wrapped = (...args: unknown[]): unknown => {
      denials.check(args[0], syscall)
      return original(...args)
    }
    return Object.assign(wrapped, original)
  }
  const patched: Record<string, unknown> = {
    ...actual,
    readFileSync: Object.assign((...args: unknown[]): unknown => {
      denials.check(args[0], 'read', true)
      return (actual.readFileSync as (...a: unknown[]) => unknown)(...args)
    }, actual.readFileSync),
    // Why: the size-capped agent-state reader opens with `openSync`, so leaving
    // it unguarded makes a denial invisible to every config/baseline read. Guard
    // it for READ intent only — a write opens 'w'/'wx'/'a', and the atomic
    // replace those writes perform must stay healthy (see `deny` above).
    openSync: Object.assign((...args: unknown[]): unknown => {
      const flags = args[1]
      const isRead = flags === undefined || (typeof flags === 'string' && flags.startsWith('r'))
      if (isRead) {
        denials.check(args[0], 'open', true)
      }
      return (actual.openSync as (...a: unknown[]) => unknown)(...args)
    }, actual.openSync),
    statSync: guard(actual.statSync, 'stat'),
    lstatSync: guard(actual.lstatSync, 'lstat'),
    existsSync: Object.assign(
      (...args: unknown[]): boolean =>
        typeof args[0] === 'string' &&
        (denials.paths.has(args[0]) || denials.existenceDeniedPaths.has(args[0]))
          ? false
          : actual.existsSync(args[0] as string),
      actual.existsSync
    )
  }
  return { ...patched, default: patched }
})

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

const realFs = await vi.importActual<typeof NodeFs>('node:fs')

const { upsertHookTrustEntries, readHookTrustEntries } = await import('./config-toml-trust')
const {
  writeCodexTrustGrantLedgerHome,
  readCodexTrustGrantLedgerHome,
  getCodexTrustGrantLedgerPath
} = await import('./codex-trust-grant-ledger')
const { readHooksJson } = await import('../agent-hooks/hooks-json-read')
const { snapshotCodexRuntimeSettingsBaseline } = await import('./config-settings-promotion')
const { getCodexConfigSyncStatus } = await import('./config-sync-stall')
const paneRegistry = await import('./codex-pane-account-registry')

let fakeHomeDir: string
let userDataDir: string
let runtimeHomePath: string
let previousUserDataPath: string | undefined

const systemHome = (): string => join(fakeHomeDir, '.codex')
const baselinePath = (): string => join(runtimeHomePath, '.orca-config-settings-baseline.json')

beforeEach(() => {
  denials.reset()
  fakeHomeDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4823-home-'))
  userDataDir = realFs.mkdtempSync(join(tmpdir(), 'orca-sta4823-data-'))
  runtimeHomePath = join(userDataDir, 'codex-runtime-home', 'home')
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
  realFs.mkdirSync(runtimeHomePath, { recursive: true })
  realFs.mkdirSync(systemHome(), { recursive: true })
  paneRegistry._internals.resetCache()
})

afterEach(() => {
  denials.reset()
  paneRegistry._internals.resetCache()
  realFs.rmSync(fakeHomeDir, { recursive: true, force: true })
  realFs.rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('STA-4823 D29 — an unreadable config.toml must not become a trust-only stub', () => {
  const USER_CONFIG = [
    'model = "gpt-5.1-codex-max"',
    'model_provider = "openai"',
    '',
    '# my notes',
    '[mcp_servers.local]',
    'command = "run-me"',
    ''
  ].join('\n')
  const ENTRY = [
    {
      sourcePath: '/tmp/hooks.json',
      eventLabel: 'stop',
      groupIndex: 0,
      hookIndex: 0,
      trustedHash: 'sha256:x',
      enabled: true
    }
  ]

  it('refuses the write rather than rebuilding the file from the trust entries alone', () => {
    const configPath = join(runtimeHomePath, 'config.toml')
    realFs.writeFileSync(configPath, USER_CONFIG, 'utf-8')
    denials.denyExistence(configPath)

    // Every hook-service caller already turns this throw into "trust entries
    // could not be written. Run /hooks in Codex to approve."
    expect(() => upsertHookTrustEntries(configPath, ENTRY as never)).toThrow('EPERM')

    // Before the fix, existsSync said the file was gone, `existing` became '',
    // and the upsert wrote a config containing ONLY the trust table — the
    // user's model, provider, MCP servers and comments all discarded.
    expect(realFs.readFileSync(configPath, 'utf-8')).toBe(USER_CONFIG)
  })

  it('still seeds a config.toml that does not exist yet', () => {
    const configPath = join(runtimeHomePath, 'config.toml')

    // Why: seeding from empty is correct for a genuine absence, and is how a
    // fresh managed home gets its trust entries at all.
    upsertHookTrustEntries(configPath, ENTRY as never)

    expect(readHookTrustEntries(configPath).size).toBeGreaterThan(0)
  })
})

describe('STA-4823 D30 — an unreadable trust-grant ledger must not be rewritten from empty', () => {
  const OTHER_HOME = '/some/other/managed/home'

  function seedLedgerWithAnotherHome(): string {
    const ledgerPath = getCodexTrustGrantLedgerPath()
    writeCodexTrustGrantLedgerHome(
      OTHER_HOME,
      { entries: { 'a:b': { trustedHash: 'sha256:other' } } } as never,
      ledgerPath
    )
    return ledgerPath
  }

  it('skips the write instead of dropping every other home', () => {
    const ledgerPath = seedLedgerWithAnotherHome()
    const before = realFs.readFileSync(ledgerPath, 'utf-8')
    denials.deny(ledgerPath)

    writeCodexTrustGrantLedgerHome(
      runtimeHomePath,
      { entries: { 'c:d': { trustedHash: 'sha256:mine' } } } as never,
      ledgerPath
    )

    // Before the fix the read degraded to an empty ledger and the write
    // persisted a file holding only this home, so every other home lost its
    // grants and would be re-prompted for trust it had already given.
    expect(realFs.readFileSync(ledgerPath, 'utf-8')).toBe(before)
  })

  it('still records a home when the ledger is readable', () => {
    const ledgerPath = seedLedgerWithAnotherHome()

    // Why: the anchor. Refusing whenever a read fails would stop the ledger
    // ever recording a grant.
    writeCodexTrustGrantLedgerHome(
      runtimeHomePath,
      { entries: { 'c:d': { trustedHash: 'sha256:mine' } } } as never,
      ledgerPath
    )

    expect(readCodexTrustGrantLedgerHome(runtimeHomePath, ledgerPath)).not.toBeNull()
    expect(readCodexTrustGrantLedgerHome(OTHER_HOME, ledgerPath)).not.toBeNull()
  })
})

describe('STA-4823 D33 — an unreadable hooks.json is not an empty hooks.json', () => {
  it('reports a failed read as unknown rather than as no hooks configured', () => {
    const hooksPath = join(runtimeHomePath, 'hooks.json')
    realFs.writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: [] } }), 'utf-8')
    denials.deny(hooksPath)

    // The read arm already returned null for a failed read; the existsSync arm
    // in front of it returned a VALID EMPTY config, and the installer then
    // wrote generated hooks over the user's file.
    expect(readHooksJson(hooksPath)).toBeNull()
  })

  it('still reports a genuinely absent hooks.json as an empty config', () => {
    // Why: absence really does mean "no hooks configured", and the installer
    // depends on that to seed one.
    expect(readHooksJson(join(runtimeHomePath, 'hooks.json'))).toEqual({})
  })
})

describe('STA-4823 D26 — an unreadable settings baseline must not be overwritten', () => {
  function seedBaseline(): string {
    realFs.writeFileSync(
      baselinePath(),
      `${JSON.stringify({ version: 2, settings: { model: 'old-model' } })}\n`,
      'utf-8'
    )
    return realFs.readFileSync(baselinePath(), 'utf-8')
  }

  it('leaves the record alone so the pending edit can still be promoted', () => {
    const before = seedBaseline()
    realFs.writeFileSync(
      join(runtimeHomePath, 'config.toml'),
      'model = "edited-in-codex"\n',
      'utf-8'
    )
    denials.deny(baselinePath())

    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)

    // Before the fix this recorded "edited-in-codex" as Orca's own write, so
    // the user's in-Codex change was never promoted and the next mirror pass
    // wrote the old value back over it.
    expect(realFs.readFileSync(baselinePath(), 'utf-8')).toBe(before)
  })

  it('still replaces a baseline that is present but malformed', () => {
    realFs.writeFileSync(baselinePath(), '{ not json', 'utf-8')
    realFs.writeFileSync(join(runtimeHomePath, 'config.toml'), 'model = "m"\n', 'utf-8')

    // Why: a corrupt baseline carries no information and resetting it IS the
    // intent. Only the unreadable case may be preserved, or a user is wedged
    // on a broken file forever.
    snapshotCodexRuntimeSettingsBaseline(runtimeHomePath)

    // Asserted against the file rather than the new observation API, so this
    // anchor still means something when the fix is reverted.
    expect(JSON.parse(realFs.readFileSync(baselinePath(), 'utf-8'))).toMatchObject({ version: 2 })
  })
})

describe('STA-4823 D15 — the sync status must not report synced while the mirror refuses', () => {
  it('reports the managed home as unavailable when its config cannot be read', () => {
    const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
    realFs.writeFileSync(runtimeConfigPath, 'model = "m"\n', 'utf-8')
    realFs.writeFileSync(join(systemHome(), 'config.toml'), 'model = "s"\n', 'utf-8')
    denials.deny(runtimeConfigPath)

    const status = getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath: systemHome() })

    // Before the fix existsSync reported the locked runtime config as absent
    // and this returned `synced` — telling the user their edits had been
    // applied while nothing had run.
    expect(status).toMatchObject({ state: 'stalled', reason: 'managed-home-unavailable' })
  })

  it('still reports synced when no runtime config exists yet', () => {
    realFs.writeFileSync(join(systemHome(), 'config.toml'), 'model = "s"\n', 'utf-8')

    // Why: with no managed config the mirror seeds one; there is nothing to
    // have fallen behind, and warning here would fire on every fresh install.
    expect(
      getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath: systemHome() })
    ).toMatchObject({ state: 'synced', reason: null })
  })
})

describe('STA-4823 D31 — an unreadable pane registry must not erase every attribution', () => {
  const PANE = 'pty-1'
  const OTHER_PANE = 'pty-2'
  const registryPath = (): string => join(userDataDir, 'codex-pane-accounts.json')

  function seedTwoAttributedPanes(): void {
    paneRegistry.recordCodexPaneAccount(PANE, {
      selectionKey: 'host',
      accountId: 'account-1',
      homeRoute: 'account-home'
    } as never)
    paneRegistry.recordCodexPaneAccount(OTHER_PANE, {
      selectionKey: 'host',
      accountId: 'account-2',
      homeRoute: 'account-home'
    } as never)
    paneRegistry._internals.resetCache()
  }

  it('does not persist an empty registry over the real one', () => {
    seedTwoAttributedPanes()
    const before = realFs.readFileSync(registryPath(), 'utf-8')
    denials.deny(registryPath())

    paneRegistry.recordCodexPaneAccount('pty-3', {
      selectionKey: 'host',
      accountId: 'account-3',
      homeRoute: 'account-home'
    } as never)

    // Before the fix the read degraded to an empty registry and this write
    // persisted it, dropping every other pane's account attribution on disk.
    expect(realFs.readFileSync(registryPath(), 'utf-8')).toBe(before)
  })

  it('does not cache the erasure, so attribution returns when the file does', () => {
    seedTwoAttributedPanes()
    denials.deny(registryPath())

    expect(paneRegistry.getCodexPaneAccount(PANE)).toBeNull()

    denials.release(registryPath())

    // THE CACHE is the second half of this defect: one unreadable read used to
    // pin the empty registry in memory for the rest of the process, so the
    // attribution never came back even after the file did.
    expect(paneRegistry.getCodexPaneAccount(PANE)).toMatchObject({ accountId: 'account-1' })
  })

  it('still reports no attribution when the registry genuinely does not exist', () => {
    // Why: a fresh install has no registry, and that really is "no panes are
    // attributed". Refusing here would make every first launch look degraded.
    expect(paneRegistry.getCodexPaneAccount(PANE)).toBeNull()
  })
})
