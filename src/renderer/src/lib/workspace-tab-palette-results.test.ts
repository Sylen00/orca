import { describe, expect, it } from 'vitest'
import type { Tab, TabContentType } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import { buildPaletteTabDocument } from './palette-match/tab-document'
import { searchWorkspaceTabs } from './workspace-tab-palette-results'
import type { SearchableWorkspaceTab } from './workspace-tab-palette-search'

const REPO_NAME = 'octo/rocket'
const WORKTREE_NAME = 'Aurora Workspace'
const BRANCH_NAME = 'main'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: WORKTREE_NAME,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeTab(id: string, contentType: TabContentType, createdAt: number): Tab {
  return {
    id,
    entityId: `${id}-entity`,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt
  }
}

function makeEntry({
  id = 'tab-1',
  contentType = 'terminal',
  createdAt = 0,
  worktree = makeWorktree(),
  agentLastActivityAt
}: {
  id?: string
  contentType?: 'terminal' | 'editor'
  createdAt?: number
  worktree?: Worktree
  agentLastActivityAt?: number
} = {}): SearchableWorkspaceTab {
  const title = id
  return {
    tab: makeTab(id, contentType, createdAt) as SearchableWorkspaceTab['tab'],
    worktree,
    repoName: REPO_NAME,
    worktreeSortIndex: 0,
    groupSortIndex: 0,
    tabSortIndex: 0,
    title,
    secondaryText: '',
    titleSearchText: title,
    secondarySearchTexts: [],
    document: buildPaletteTabDocument({
      id,
      title,
      secondaryTexts: [],
      worktreeName: WORKTREE_NAME,
      branch: BRANCH_NAME,
      repoName: REPO_NAME
    }),
    agentMetadata:
      agentLastActivityAt === undefined
        ? []
        : [
            {
              paneKey: `${id}-pane`,
              textParts: [],
              snippetCandidates: [],
              lastActivityAt: agentLastActivityAt
            }
          ],
    isCurrentTab: false,
    isCurrentWorktree: true
  }
}

describe('searchWorkspaceTabs lastActiveAt', () => {
  it('is null when neither agent activity nor worktree activity is known', () => {
    const [result] = searchWorkspaceTabs([makeEntry()], '')
    expect(result.lastActiveAt).toBeNull()
  })

  it('falls back to worktree PTY activity for editor tabs with no agent metadata', () => {
    const entry = makeEntry({
      contentType: 'editor',
      worktree: makeWorktree({ lastActivityAt: 5000 })
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(5000)
  })

  it('prefers agent activity over worktree activity when agent activity is newer', () => {
    const entry = makeEntry({
      worktree: makeWorktree({ lastActivityAt: 1000 }),
      agentLastActivityAt: 9000
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(9000)
  })

  it('prefers agent activity even when it is older than worktree activity', () => {
    const entry = makeEntry({
      worktree: makeWorktree({ lastActivityAt: 9000 }),
      agentLastActivityAt: 1000
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(1000)
  })

  it('clamps to the tab creation time when the activity signal predates it', () => {
    const entry = makeEntry({
      createdAt: 4000,
      worktree: makeWorktree({ lastActivityAt: 1000 })
    })
    const [result] = searchWorkspaceTabs([entry], '')
    expect(result.lastActiveAt).toBe(4000)
  })
})
