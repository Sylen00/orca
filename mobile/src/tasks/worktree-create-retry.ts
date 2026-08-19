import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse, RpcSuccess } from '../transport/types'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { waitForRpcClientReconnected } from '../transport/rpc-client-reconnect-wait'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import {
  CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS,
  getClientWorktreeCreateCandidate,
  getGeneratedWorktreeCreateRetryCandidate,
  isRetryableWorktreeCreateConflict
} from '../../../src/shared/new-workspace/worktree-create-retry-policy'
import { WORKTREE_CREATE_TIMEOUT_MS } from './workspace-create-timeout'

// Why: server-side collision checks (branch already exists locally / on a remote
// / already has PR #N) can fire even after a pre-flight basename dedupe —
// branches outlive worktrees in git, and remote branches/PRs aren't visible from
// worktree.ps. Retry by appending -2, -3, ... mirroring the desktop createWorktree
// loop in src/renderer/src/store/slices/worktrees.ts.
export type WorktreeCreateResult = { worktreeId: string; name: string } | { error: string }

// Why: a create in flight when the mobile transport migrates (relay/direct
// hand-off on shoddy cellular, relay lease rotation) rejects with a cutover error
// even though the host may have completed it. The shared clientMutationId makes a
// retry idempotent, so re-issue on the fresh session a bounded number of times
// instead of surfacing "RPC interrupted by connection migration" with the
// worktree silently created.
const WORKTREE_CREATE_CUTOVER_MAX_RETRIES = 5

// Why: a connection migration is not the only way a create goes delivery-ambiguous.
// A plain socket close (cellular flap, relay drop, the phone backgrounding and the
// supervisor suspending a billed relay splice) rejects the in-flight frame as
// delivery-unknown with no generation bump, and create holds the longest budget of
// any mobile RPC — 10 minutes of clone/fetch/setup — so it is the likeliest request
// to be caught by one. Surfacing that as a failure is wrong: the host may well have
// finished the worktree. Replay on the same clientMutationId instead.
const WORKTREE_CREATE_AMBIGUOUS_MAX_RETRIES = 2
// Why: the host drops a completed create's dedupe record 60s after it resolves, so
// keep the whole replay window comfortably inside that or a replay lands as a fresh
// create and suffixes a duplicate. An in-flight create is deduped without any TTL.
const WORKTREE_CREATE_AMBIGUOUS_RECONNECT_WAIT_MS = 20_000

export type CreateWorktreeWithNameRetryArgs = {
  client: RpcClient
  baseName: string
  nameWasGenerated?: boolean
  buildParams: (name: string) => Record<string, unknown>
  supportsIdempotentCutoverRetry: boolean | Promise<boolean>
  maxAttempts?: number
  // Injected in tests; production mints a fresh idempotency key per candidate.
  mintMutationId?: () => string
}

// Creates a worktree, retrying with a numeric suffix on a name-collision error.
// buildParams receives the candidate name so callers can assemble source-specific
// params (linked issue/PR, base branch, etc.) around it. Callers that can't clear
// a collision by re-suffixing (e.g. reusing a fixed existing branch) pass
// maxAttempts: 1 to fail fast instead of burning the full retry budget.
export async function createWorktreeWithNameRetry(
  args: CreateWorktreeWithNameRetryArgs
): Promise<WorktreeCreateResult> {
  const { client, baseName, buildParams } = args
  // Why: creating before status.get settles would silently disable safe replay
  // during the exact slow-network window this path is meant to recover from.
  const supportsIdempotentCutoverRetry = await args.supportsIdempotentCutoverRetry
  const maxAttempts = args.maxAttempts ?? CLIENT_WORKTREE_CREATE_MAX_ATTEMPTS
  const mintMutationId = args.mintMutationId ?? defaultWorktreeCreateMutationId
  let lastError: string | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidateName = args.nameWasGenerated
      ? getGeneratedWorktreeCreateRetryCandidate(baseName, attempt)
      : getClientWorktreeCreateCandidate(baseName, attempt)
    const candidateParams = buildParams(candidateName)
    // Why: older hosts strip unknown fields, so only stamp and replay when the
    // host advertises idempotency. One key per candidate makes cutover retries
    // safe while a name-collision bump remains a genuinely new create.
    const params = supportsIdempotentCutoverRetry
      ? { ...candidateParams, clientMutationId: mintMutationId() }
      : candidateParams
    const response = await sendWorktreeCreateResilient(
      client,
      params,
      supportsIdempotentCutoverRetry
    )
    if (response.ok) {
      const result = (response as RpcSuccess).result as { worktree: { id: string } }
      return { worktreeId: result.worktree.id, name: candidateName }
    }
    lastError = response.error.message
    if (!isRetryableWorktreeCreateConflict(lastError ?? '')) {
      break
    }
  }
  return { error: lastError ?? 'Failed to create workspace' }
}

// Sends worktree.create, re-issuing whenever the request went delivery-ambiguous —
// the frame reached the wire but no response came back, so the host may already have
// built the worktree. The shared clientMutationId in `params` keeps the retry
// idempotent host-side. A definite failure (never sent, or a server error response)
// is returned to the caller untouched.
async function sendWorktreeCreateResilient(
  client: RpcClient,
  params: Record<string, unknown>,
  supportsIdempotentCutoverRetry: boolean
): Promise<RpcResponse> {
  let migrationRetry = 0
  let ambiguousRetry = 0
  for (;;) {
    try {
      return await client.sendRequest('worktree.create', params, {
        timeoutMs: WORKTREE_CREATE_TIMEOUT_MS
      })
    } catch (error) {
      if (!supportsIdempotentCutoverRetry) {
        throw error
      }
      if (isLogicalClientCutoverError(error)) {
        if (migrationRetry >= WORKTREE_CREATE_CUTOVER_MAX_RETRIES) {
          throw error
        }
        migrationRetry += 1
        // Why: LogicalClientCutoverError is raised only after migrateTo installs an
        // authenticated replacement, so retry immediately instead of adding UI lag.
        continue
      }
      if (!isRpcDeliveryUnknown(error) || ambiguousRetry >= WORKTREE_CREATE_AMBIGUOUS_MAX_RETRIES) {
        throw error
      }
      ambiguousRetry += 1
      // Why: unlike a cutover, no replacement session exists yet — resending now
      // would just hit the dead one, so wait for the transport to come back and
      // surface the original ambiguity if it does not.
      if (
        !(await waitForRpcClientReconnected(client, WORKTREE_CREATE_AMBIGUOUS_RECONNECT_WAIT_MS))
      ) {
        throw error
      }
    }
  }
}

function defaultWorktreeCreateMutationId(): string {
  const randomPart = Math.random().toString(36).slice(2, 10)
  return `worktree-create:${Date.now().toString(36)}:${randomPart}`
}
