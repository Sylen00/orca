import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { getActiveNativeChatWatcherCount, subscribeNativeChatTranscript } from './transcript-watch'

let tempRoots: string[] = []

beforeEach(() => {
  tempRoots = []
})

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function pendingFilePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-chat-unresolved-'))
  tempRoots.push(root)
  return join(root, 'rollout.jsonl')
}

function claudeLine(uuid: string, role: 'user' | 'assistant', text: string): string {
  return `${JSON.stringify({
    type: role,
    uuid,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }] }
  })}\n`
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timed out')
}

type Snapshot = { messages: NativeChatMessage[]; error?: string }

// #13663: an agent in an SSH worktree writes its transcript on the remote host,
// so this host resolves nothing and the poll spins forever with no frame — the
// client sits on a spinner indefinitely. The poll is still correct for a
// not-yet-flushed local session (#8401), so the notice must be advisory.
describe('subscribeNativeChatTranscript unresolved-transcript notice (#13663)', () => {
  it('reports the transcript as unavailable once the deadline passes', async () => {
    const snapshots: Snapshot[] = []

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath: await pendingFilePath(),
      onAppend: () => {},
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
        snapshots.push({ messages, error }),
      resolvePollIntervalMs: 10,
      unresolvedNoticeMs: 30
    })

    await waitFor(() => snapshots.length > 0)
    expect(snapshots[0]?.messages).toEqual([])
    expect(snapshots[0]?.error).toMatch(/unavailable on this host/i)

    sub.unsubscribe()
  })

  it('stays silent before the deadline so a slow first flush is not called an error', async () => {
    const snapshots: Snapshot[] = []
    const filePath = await pendingFilePath()

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: () => {},
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
        snapshots.push({ messages, error }),
      resolvePollIntervalMs: 10,
      unresolvedNoticeMs: 10_000
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(snapshots).toHaveLength(0)

    sub.unsubscribe()
  })

  // The notice must not be a terminal state: the poll keeps running, so a
  // transcript that shows up late still loads.
  it('keeps polling after the notice and still tails the file once it appears', async () => {
    const snapshots: Snapshot[] = []
    const appended: NativeChatMessage[] = []
    const filePath = await pendingFilePath()

    const sub = await subscribeNativeChatTranscript({
      agent: 'claude',
      sessionId: 'ignored',
      filePath,
      onAppend: (messages) => appended.push(...messages),
      onInitialSnapshot: (messages, _hasMore, _beforeOffset, error) =>
        snapshots.push({ messages, error }),
      debounceMs: 5,
      resolvePollIntervalMs: 10,
      unresolvedNoticeMs: 30
    })

    await waitFor(() => snapshots.some((s) => s.error))

    await writeFile(filePath, claudeLine('u-1', 'user', 'late but real'))
    await waitFor(() => appended.some((m) => m.id === 'u-1') || snapshots.length > 1)

    expect(getActiveNativeChatWatcherCount()).toBe(1)
    // Exactly one advisory frame — it must not repeat on every poll tick.
    expect(snapshots.filter((s) => s.error)).toHaveLength(1)

    sub.unsubscribe()
    expect(getActiveNativeChatWatcherCount()).toBe(0)
  })
})
