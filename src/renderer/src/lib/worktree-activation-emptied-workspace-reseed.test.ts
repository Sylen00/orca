import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
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
