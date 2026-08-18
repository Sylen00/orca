import { describe, expect, it } from 'vitest'
import {
  selectOffscreenBrowserPagesToClose,
  selectOffscreenBrowserPagesToPark,
  type OffscreenBrowserReclaimCandidate,
  type OffscreenBrowserReclaimPolicy
} from './offscreen-browser-page-reclaim'

const NOW = 1_000_000

const POLICY: OffscreenBrowserReclaimPolicy = {
  residentLimit: 2,
  idleParkMs: 60_000,
  parkGraceMs: 5_000,
  sweepIntervalMs: 1_000,
  retainedPageLimit: 100
}

function page(
  browserPageId: string,
  idleMs: number,
  pinned = false
): OffscreenBrowserReclaimCandidate {
  return { browserPageId, lastActivityAt: NOW - idleMs, pinned }
}

describe('selectOffscreenBrowserPagesToPark', () => {
  it('keeps everything resident while the working set fits under the cap', () => {
    expect(
      selectOffscreenBrowserPagesToPark([page('a', 10_000), page('b', 20_000)], NOW, POLICY)
    ).toEqual([])
  })

  it('parks the least recently used pages down to the cap', () => {
    const parked = selectOffscreenBrowserPagesToPark(
      [page('newest', 6_000), page('oldest', 40_000), page('middle', 20_000)],
      NOW,
      POLICY
    )
    expect(parked).toEqual(['oldest'])
  })

  it('parks an idle page even when the working set fits under the cap', () => {
    expect(
      selectOffscreenBrowserPagesToPark([page('a', 10_000), page('stale', 90_000)], NOW, POLICY)
    ).toEqual(['stale'])
  })

  it('never parks a page inside the grace window, even over the cap', () => {
    // Why: a page touched moments ago is the one an agent is mid-workflow on.
    const parked = selectOffscreenBrowserPagesToPark(
      [page('a', 100), page('b', 200), page('c', 300), page('d', 400)],
      NOW,
      POLICY
    )
    expect(parked).toEqual([])
  })

  it('never parks a pinned page and lets it push the cap', () => {
    const parked = selectOffscreenBrowserPagesToPark(
      [
        page('streamed', 200_000, true),
        page('alsoStreamed', 300_000, true),
        page('idle', 40_000),
        page('idler', 50_000)
      ],
      NOW,
      POLICY
    )
    // Two pinned pages already fill the cap, so both evictable pages go.
    expect(parked.sort()).toEqual(['idle', 'idler'])
  })

  it('counts pinned pages against the cap without evicting them', () => {
    const parked = selectOffscreenBrowserPagesToPark(
      [page('pinned', 200_000, true), page('a', 10_000), page('b', 20_000)],
      NOW,
      POLICY
    )
    expect(parked).toEqual(['b'])
  })

  it('is deterministic when two pages share a last-activity stamp', () => {
    const candidates = [page('zebra', 30_000), page('apple', 30_000), page('mango', 1_000)]
    const first = selectOffscreenBrowserPagesToPark(candidates, NOW, POLICY)
    const second = selectOffscreenBrowserPagesToPark(candidates.toReversed(), NOW, POLICY)
    expect(first).toEqual(['apple'])
    expect(second).toEqual(first)
  })

  it('parks nothing when the policy disables both evictors', () => {
    expect(
      selectOffscreenBrowserPagesToPark([page('a', 10_000_000), page('b', 10_000_000)], NOW, {
        ...POLICY,
        residentLimit: Number.MAX_SAFE_INTEGER,
        idleParkMs: Number.MAX_SAFE_INTEGER
      })
    ).toEqual([])
  })
})

describe('selectOffscreenBrowserPagesToClose', () => {
  it('retains every parked page under the limit', () => {
    expect(selectOffscreenBrowserPagesToClose([page('a', 1), page('b', 2)], 2, POLICY)).toEqual([])
  })

  it('closes the least recently used parked pages down to the limit', () => {
    // Why: parking bounds renderer processes, not the records behind them.
    const parked = [page('new', 1_000), page('old', 90_000), page('older', 99_000)]
    expect(
      selectOffscreenBrowserPagesToClose(parked, 5, { ...POLICY, retainedPageLimit: 3 })
    ).toEqual(['older', 'old'])
  })

  it('never closes a pinned page', () => {
    const parked = [page('pinned', 99_000, true), page('idle', 90_000)]
    expect(
      selectOffscreenBrowserPagesToClose(parked, 4, { ...POLICY, retainedPageLimit: 2 })
    ).toEqual(['idle'])
  })
})
