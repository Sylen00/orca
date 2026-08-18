import { describe, expect, it } from 'vitest'
import type { BrowserTabInfo } from '../../shared/runtime-types'
import type { ParkedBrowserPage } from './browser-backend'
import { mergeParkedBrowserTabs } from './headless-browser-tab-listing'

function live(browserPageId: string, index: number, active = false): BrowserTabInfo {
  return {
    browserPageId,
    index,
    url: `https://example.test/${browserPageId}`,
    title: browserPageId,
    active
  }
}

function parked(browserPageId: string, active = false): ParkedBrowserPage {
  return {
    browserPageId,
    worktreeId: 'wt-1',
    profileId: 'default',
    url: `https://example.test/${browserPageId}`,
    title: browserPageId,
    active
  }
}

describe('mergeParkedBrowserTabs', () => {
  it('returns the live listing untouched when nothing is parked', () => {
    const tabs = [live('a', 0, true), live('b', 1)]
    expect(mergeParkedBrowserTabs(tabs, [])).toEqual(tabs)
  })

  it('appends parked pages with continuous indices', () => {
    const merged = mergeParkedBrowserTabs([live('a', 0, true)], [parked('b'), parked('c')])
    expect(merged.map((tab) => [tab.browserPageId, tab.index, tab.parked === true])).toEqual([
      ['a', 0, false],
      ['b', 1, true],
      ['c', 2, true]
    ])
  })

  it('lets a parked page stay active when nothing live claims it', () => {
    // Why: parking clears the bridge pointer, but the paired client's tab bar
    // must not lose its selection just because the renderer was reclaimed.
    const merged = mergeParkedBrowserTabs([], [parked('b', true), parked('c')])
    expect(merged.map((tab) => tab.active)).toEqual([true, false])
  })

  it('never reports two active tabs', () => {
    const merged = mergeParkedBrowserTabs([live('a', 0, true)], [parked('b', true)])
    expect(merged.filter((tab) => tab.active).map((tab) => tab.browserPageId)).toEqual(['a'])
  })

  it('carries worktree and profile identity for parked pages', () => {
    const [tab] = mergeParkedBrowserTabs([], [parked('b')])
    expect(tab).toMatchObject({
      browserPageId: 'b',
      worktreeId: 'wt-1',
      profileId: 'default',
      parked: true
    })
  })
})
