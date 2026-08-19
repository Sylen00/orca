import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { ConnectionState } from '../transport/types'
import { createWorktreeWithNameRetry } from './worktree-create-retry'

type Attempt = { method: string; params: Record<string, unknown> }

// Drives the transport state a replay has to wait on. Production couples the two:
// a socket close rejects the pending frame AND drops the client off 'connected'.
function connectionController(): {
  getState: () => ConnectionState
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  set: (next: ConnectionState) => void
} {
  let state: ConnectionState = 'connected'
  const listeners = new Set<(next: ConnectionState) => void>()
  return {
    getState: () => state,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

// Lets a parked replay reach its state wait before the test resumes the transport.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// A client whose per-call outcome is scripted: return an id, a server error
// message, or throw (transport-level rejection, e.g. a connection-migration
// cutover). Records every call so tests can assert on the clientMutationId.
function scriptedClient(
  outcomes: Array<
    { id: string } | { errorMessage: string } | { throws: unknown; dropsConnection?: boolean }
  >,
  attempts: Attempt[],
  connection?: ReturnType<typeof connectionController>
): RpcClient {
  let call = 0
  return {
    getState: () => connection?.getState() ?? 'connected',
    onStateChange: (listener: (state: ConnectionState) => void) =>
      connection?.onStateChange(listener) ?? (() => {}),
    sendRequest: async (method: string, params?: unknown) => {
      attempts.push({ method, params: (params ?? {}) as Record<string, unknown> })
      const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
      call += 1
      if ('throws' in outcome) {
        if (outcome.dropsConnection) {
          connection?.set('reconnecting')
        }
        throw outcome.throws
      }
      if ('errorMessage' in outcome) {
        return {
          id: '1',
          ok: false,
          error: { code: 'x', message: outcome.errorMessage },
          _meta: { runtimeId: 'r' }
        }
      }
      return {
        id: '1',
        ok: true,
        result: { worktree: { id: outcome.id } },
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient
}

describe('createWorktreeWithNameRetry', () => {
  it('waits for capability detection before sending a create', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-ready' }], attempts)
    let resolveSupport!: (supported: boolean) => void
    const support = new Promise<boolean>((resolve) => {
      resolveSupport = resolve
    })
    const pending = createWorktreeWithNameRetry({
      client,
      baseName: 'puffin',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: support,
      mintMutationId: () => 'key-ready'
    })

    await Promise.resolve()
    expect(attempts).toHaveLength(0)
    resolveSupport(true)

    await expect(pending).resolves.toEqual({ worktreeId: 'wt-ready', name: 'puffin' })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBe('key-ready')
  })

  it('stamps a clientMutationId on the create request', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-1' }], attempts)
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => 'key-1'
    })
    expect(result).toEqual({ worktreeId: 'wt-1', name: 'otter' })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params).toMatchObject({ name: 'otter', clientMutationId: 'key-1' })
  })

  it('retries a connection-migration cutover with the SAME key, then succeeds', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: new LogicalClientCutoverError() }, { id: 'wt-2' }],
      attempts
    )
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'seal',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => 'key-mig'
    })
    expect(result).toEqual({ worktreeId: 'wt-2', name: 'seal' })
    expect(attempts).toHaveLength(2)
    // Idempotency: both the interrupted send and the retry carry one key so the
    // host dedupes instead of creating a duplicate worktree.
    expect(attempts[0]!.params.clientMutationId).toBe('key-mig')
    expect(attempts[1]!.params.clientMutationId).toBe('key-mig')
    expect(attempts[1]!.params.name).toBe('seal')
  })

  it('gives up after the cutover retry budget and rethrows', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new LogicalClientCutoverError() }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'crab',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-x'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    // Initial attempt + 5 retries.
    expect(attempts).toHaveLength(6)
  })

  it('does not treat an ordinary transport error as a cutover', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new Error('Request timed out') }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'eel',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-t'
      })
    ).rejects.toThrow('Request timed out')
    expect(attempts).toHaveLength(1)
  })

  it('mints a fresh key per candidate when a name collision bumps the suffix', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-3' }],
      attempts
    )
    let n = 0
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => `key-${(n += 1)}`
    })
    expect(result).toEqual({ worktreeId: 'wt-3', name: 'topic-2' })
    expect(attempts).toHaveLength(2)
    // A collision is a genuinely different create, so it gets a distinct key.
    expect(attempts[0]!.params.clientMutationId).toBe('key-1')
    expect(attempts[1]!.params.clientMutationId).toBe('key-2')
    expect(attempts[1]!.params.name).toBe('topic-2')
  })

  it('advances generated retries without nesting suffixes', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-generated' }],
      attempts
    )

    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'nautilus-2',
      nameWasGenerated: true,
      buildParams: (name) => ({ repo: 'id:r', name, nameWasGenerated: true }),
      supportsIdempotentCutoverRetry: false
    })

    expect(result).toEqual({ worktreeId: 'wt-generated', name: 'nautilus-3' })
    expect(attempts.map((attempt) => attempt.params.name)).toEqual(['nautilus-2', 'nautilus-3'])
  })

  it('does not replay an ambiguous cutover when the host lacks idempotency support', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new LogicalClientCutoverError() }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'ray',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: false,
        mintMutationId: () => 'must-not-be-used'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBeUndefined()
  })

  it('replays a delivery-ambiguous socket drop with the SAME key once the transport returns', async () => {
    const attempts: Attempt[] = []
    const connection = connectionController()
    const client = scriptedClient(
      [
        {
          throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
          dropsConnection: true
        },
        { id: 'wt-drop' }
      ],
      attempts,
      connection
    )

    const pending = createWorktreeWithNameRetry({
      client,
      baseName: 'urchin',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => 'key-drop'
    })

    await flush()
    // Parked on the reconnect, not resent onto a dead socket.
    expect(attempts).toHaveLength(1)

    connection.set('connected')
    await expect(pending).resolves.toEqual({ worktreeId: 'wt-drop', name: 'urchin' })
    expect(attempts).toHaveLength(2)
    // Idempotency: the host dedupes the replay against the create it may already
    // have finished, instead of building a second worktree.
    expect(attempts[1]!.params.clientMutationId).toBe('key-drop')
    expect(attempts[1]!.params.name).toBe('urchin')
  })

  it('does not replay a delivery-ambiguous drop when the host lacks idempotency support', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: markRpcDeliveryUnknown(new Error('Connection interrupted')) }],
      attempts
    )
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'limpet',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: false,
        mintMutationId: () => 'must-not-be-used'
      })
    ).rejects.toThrow('Connection interrupted')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBeUndefined()
  })

  it('gives up after the delivery-ambiguity replay budget and rethrows', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: markRpcDeliveryUnknown(new Error('Connection interrupted')) }],
      attempts
    )
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'barnacle',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-budget'
      })
    ).rejects.toThrow('Connection interrupted')
    // Initial attempt + 2 replays; the window stays inside the host's post-success
    // dedupe TTL so a replay can't outlive the record it is meant to match.
    expect(attempts).toHaveLength(3)
  })

  it('surfaces the original ambiguity when the transport never comes back', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true
          }
        ],
        attempts,
        connection
      )

      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'anemone',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-stuck'
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      // A phone that never reconnects must not leave the Create spinner parked.
      await vi.advanceTimersByTimeAsync(60_000)
      await settled
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
