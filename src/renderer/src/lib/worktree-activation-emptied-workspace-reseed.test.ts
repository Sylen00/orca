import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealFolderWorkspace, activateAndRevealWorktree } from './worktree-activation'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent-test-state'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

/** The state a workspace lands in once its last terminal is closed: the row survives as an
 *  explicit empty list rather than disappearing. */
function seedClosedLastTerminal(worktreeId: string): void {
  useAppStore.setState({ tabsByWorktree: { [worktreeId]: [] } })
  const { renderableTabCount } = useAppStore.getState().reconcileWorktreeTabModel(worktreeId)
  expect(renderableTabCount).toBe(0)
}

describe('activating a workspace whose last terminal was closed', () => {
  it('re-seeds a terminal when the workspace is opened from elsewhere', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const result = activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeTruthy()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
  })

  it('keeps the workspace empty when reselecting the row it is already showing', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({ activeWorktreeId: worktree.id, activeView: 'terminal' })

    const result = activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(result).toEqual({ primaryTabId: null })
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('leaves the row empty for startup hydration, which never opts into re-seeding', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const tabId = ensureWorktreeHasInitialTerminal(useAppStore.getState(), worktree.id)

    expect(tabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })
})

const FOLDER_ID = 'folder-1'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_ID)
const SSH_HOST_ID = toSshExecutionHostId('conn-1')

/** One folder id resolves to a different `FolderWorkspace` per host while both share a single
 *  `tabsByWorktree[FOLDER_KEY]` row, so the reselect guard has to compare hosts too. */
function seedEmptiedFolderWorkspaceOnTwoHosts(): void {
  const base = {
    id: FOLDER_ID,
    projectGroupId: 'group-1',
    name: 'notes',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0
  }
  useAppStore.setState({
    folderWorkspaces: [
      { ...base, folderPath: '/local/notes', executionHostId: 'local' },
      // Why: an SSH host, not a runtime one — runtime-owned workspaces never seed a local
      // terminal at all, so they cannot exercise the reselect guard.
      { ...base, folderPath: '/remote/notes', executionHostId: SSH_HOST_ID, connectionId: 'conn-1' }
    ] as unknown as ReturnType<typeof useAppStore.getState>['folderWorkspaces'],
    activeView: 'terminal',
    tabsByWorktree: { [FOLDER_KEY]: [] },
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    getFreshFolderWorkspacePathStatus: () => ({ exists: true }),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
  expect(useAppStore.getState().reconcileWorktreeTabModel(FOLDER_KEY).renderableTabCount).toBe(0)
}

describe('activating a folder workspace whose last terminal was closed', () => {
  it('re-seeds a terminal when the workspace is opened from elsewhere', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: 'local' })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(1)
  })

  it('keeps the workspace empty when reselecting the same host it is already showing', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    useAppStore.setState({
      activeWorktreeId: FOLDER_KEY,
      activeWorkspaceExecutionHostId: 'local'
    })

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: 'local' })

    expect(result).toEqual({ primaryTabId: null })
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toEqual([])
  })

  it('re-seeds when opening the same folder id on a different host', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    useAppStore.setState({
      activeWorktreeId: FOLDER_KEY,
      activeWorkspaceExecutionHostId: 'local'
    })

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, {
      executionHostId: SSH_HOST_ID
    })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(1)
  })
})
