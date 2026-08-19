# Findings packet — readiness round 5

Branch: `linear-project-edit` (uncommitted working tree)
Base (merge-base with main): 604169f4af0dce42f05854ee9541d2b3fe87d361
HEAD: 42e5a486b35842781f315043b051424e630b095b
Worktree: /Users/jinjingliang/Documents/projects/orca/linear-project-writes

Feature under review: a new `orca linear project create | edit | show | update add | statuses | labels`
CLI surface, six new RPC methods, an SSH remote mirror, and relay stdin forwarding.

Note: there is no "original PR" — this is an uncommitted working tree on a feature branch.
Treat TARGET = the current working tree at the file:line cited.

Verification state (independently reproduced by the coordinator):
`npx vitest run --config config/vitest.config.ts src/cli src/main/linear src/main/ssh src/main/runtime src/relay src/shared/linear`
= 738 files passed, 9111 tests passed, 0 failed, 19 skipped.

---

## R5-01 — claimed P1 — read caps are below write caps, enabling silent destructive read-modify-write

TARGET:
- `src/main/linear/project-agent-read.ts:79-90` (`boundedLinearString(node.description)`, `boundedLinearNullableString(node.content)`, `boundedLinearEntityCollection(members|teams|labels)`)
- `src/shared/linear/agent-access.ts:4` `LINEAR_COMMENT_BODY_CAP = 20_000`
- `src/shared/linear/agent-access.ts:11` `LINEAR_WRITE_BODY_CAP = 65_000`
- `src/shared/linear/project-agent-access.ts:13` `LINEAR_PROJECT_ENTITY_OUTPUT_CAP = 200`
- `src/main/linear/linear-text-digest.ts:19-31` (`boundedLinearString`)
- `skill-guides/orca-linear.md` (no mention of truncation anywhere; `grep -n "truncat" skill-guides/orca-linear.md` returns nothing)

CLAIM: `orca linear project show --json` returns `content` truncated at 20,000 chars and
`members`/`teams`/`labels` truncated at 200 items, while `orca linear project edit` accepts
content up to 65,000 chars and treats repeated `--member`/`--team`/`--label` as a DESTRUCTIVE
REPLACEMENT of the whole collection. The natural agent workflow for "add Ada to this project"
is `project show --json` -> take `project.members.items` -> append Ada -> `project edit --member` x N.
On a project with 260 members that silently REMOVES 60 members; on a 40,000-char overview,
appending a paragraph silently DESTROYS 20,000 characters. `previous.*` in the edit result is
bounded by the same caps, so Orca's own output cannot reconstruct what was lost.
Mitigations that DO exist: the JSON carries `truncated: true`, `chars` (full length), and
`sha256` of the full text, and human output prints `(truncated)` / `(showing N)`.
Mitigation that does NOT exist: neither the skill guides, the command spec notes
(`src/cli/specs/linear-project.ts`), nor the help text tells the agent that a replacement must
never be built from `project show` output when `truncated` is true. There is also no command
in the new surface that returns the full untruncated overview.
Executed evidence: `project show content: chars=40000 value.length=20000 truncated=true`;
`project show members: total=260 items=200 truncated=true`.

## R5-02 — claimed P2 — `update add` unconfirmed-retry command omits `--health` and `--hide-diff`

TARGET: `src/main/runtime/linear-project-write-recovery.ts:110-118` vs
`src/main/runtime/linear-project-update-write-intent.ts:27-36`

CLAIM: `updatePostUnconfirmed` builds the pinned retry command from only
`[target, body-source, --write-id, --workspace, --json]`. It never emits `--health` or
`--hide-diff`. But `projectUpdateMatchesAddIntent` compares `record.isDiffHidden === intent.isDiffHidden`
unconditionally and `record.health === intent.health` when health was requested. So for
`orca linear project update add P --body B --health at-risk --hide-diff --write-id W` that times out:
(a) if the original DID land, running the exact command Orca printed sends `isDiffHidden:false` and
no health, the write-id probe mismatches, and the retry is refused with `linear_invalid_write_id`
("belongs to a project update with different content") — blaming the agent for following Orca's
own instructions; (b) if it did NOT land, the retry posts with the diff VISIBLE and default health,
silently discarding what the user asked for. The values are present in `error.data.health` /
`error.data.isDiffHidden`; only the command line omits them. `createUnconfirmed` has no equivalent
gap — its command carries every intent field.

## R5-03 — claimed P2 — the 30s intent-resolution deadline does not cover four unbounded, un-abortable Linear reads on the same write paths

TARGET: `src/main/runtime/orca-runtime.ts:35451`, `:35462`, `:35619-35620`, `:35685-35686`
(and the guarded helper at `:35597-35613`, `LINEAR_INTENT_RESOLUTION_DEADLINE_MS` at `:2043`)

CLAIM: `resolveLinearWriteIntent` correctly wraps `resolveLinearProjectCreateIntent` and
`resolveLinearProjectEditIntent` in a 30s AbortController, and the signal is genuinely plumbed to
`fetch` (verified: `project-write-references.ts` -> `project-agent-request.ts:21-23` ->
`new LinearClient({ apiKey, signal })`). But four sibling reads on the SAME write paths are called
WITHOUT the signal and OUTSIDE both the 30s resolution deadline and the 25s write deadline:
- `:35451` `resolveLinearProjectTarget(input, workspaceId)` — third `options` arg omitted although
  `src/main/linear/project-target-resolution.ts:36-39` accepts and threads `signal`. For a non-UUID
  target this is a `Promise.all` fan-out across every connected workspace, each doing a paged
  slug+name search. Runs BEFORE the deadlined resolution on both `edit` and `update add`.
- `:35462` update-add write-id probe, `:35619-35620` create dedup probe, `:35685-35686` pre-edit
  snapshot — all `readLinearWriteLookup(() => getProjectByIdForAgent(id, ws))` with the `{ signal }`
  argument omitted, although `src/main/linear/project-create.ts:67-77` accepts it. The pre-edit
  snapshot's `completeProjectWriteRecord` runs three cursor walks bounded only by
  `PROJECT_CONNECTION_PAGE_LIMIT = 200` (up to ~601 sequential round-trips), uncancellable.
Composition: 30s + 25s = 55s < the CLI's `LINEAR_WRITE_TIMEOUT_MS = 75_000`
(`src/cli/handlers/linear-project-writes.ts:20`), so the two DEADLINED phases compose fine. The
un-deadlined reads are what can bust 75s. When they do, the client abandons and the agent gets the
CLI's own RPC timeout instead of the `linear_write_unconfirmed` envelope with digests and a pinned
retry — and `project edit` has no write id, so its retry is blind. That envelope is the entire
point of the feature's recovery design. (Not affected over SSH: the relay budget is 5 minutes,
`src/relay/remote-cli-timeout.ts:14`.)

## R5-04 — claimed P2 — `--hide-diff=true` and `--updates=true` are silently ignored

TARGET: `src/cli/args.ts:107-112` (the `=` branch runs BEFORE the `BOOLEAN_FLAGS.has(flag)` branch
at `:115`), consumed at `src/cli/linear-project-request-builders.ts:69` (`flags.get('updates') === true`)
and `:116` (`isDiffHidden: flags.get('hide-diff') === true`).

CLAIM: `hide-diff` (`args.ts:41`) and `updates` (`args.ts:68`) were added to `BOOLEAN_FLAGS` by this
diff, but `parseArgs` resolves `--flag=value` into a STRING before consulting `BOOLEAN_FLAGS`, and
nothing rejects a value on a boolean flag. So `orca linear project update add P --body B --hide-diff=true`
posts the update with the auto-generated scope/progress diff VISIBLE, exit 0, no warning — project
updates are append-only. `orca linear project show P --updates=true` returns a project with no updates.
The author demonstrably knew this hazard: `rejectValuedClearFlags`
(`src/cli/linear-project-edit-request.ts:97-103`) rejects `--clear-content=false` with
"`--clear-<x> takes no value`", and the SSH mirror does the same at
`src/main/ssh/ssh-remote-linear-project-edit-request.ts:207-222`. These two flags were simply not
covered. The SSH mirror has the identical gap
(`src/main/ssh/ssh-remote-linear-project-write-cli.ts:211`,
`src/main/ssh/ssh-remote-linear-project-read-cli.ts:86`).
Mitigating: the documented spelling is the bare `--hide-diff` / `--updates`, which works correctly.

## R5-05 — claimed P2 — SSH `project create` still silently drops empty `--status=` / `--lead=` and turns `--member=` / `--label=` into an empty collection, where local now errors

TARGET: `src/main/ssh/ssh-remote-linear-project-write-cli.ts:130-137`;
`optionalString` at `src/main/ssh/ssh-remote-linear-write-support.ts:301-307`
(`typeof value === 'string' && value.length > 0 ? value : undefined`);
`referenceList('members').optional()` (no `.min(1)`) at
`src/main/runtime/rpc/methods/linear-agent-project-writes.ts:59-60`.

CLAIM: A previous round found `orca linear project create --lead=` mapped to `undefined`, creating
the project with no lead at exit 0. The fix added `readOptionalReference` to the LOCAL builder
(`src/cli/linear-project-request-builders.ts`) so `--status=` / `--lead=` now throw
"`--<name> needs a value`". The SSH transport was not fixed and still uses `optionalString`.
Same argv, same user, opposite outcome depending only on whether the shell is on an SSH remote:
`orca linear project create --name P --team ENG --lead=` errors locally, and creates a project with
no lead (exit 0) over SSH. Likewise `--member=` / `--label=`: the SSH path gates on
`parsed.flags.has('member')` and then calls `repeatedString`, which yields `[]`; the host's zod
accepts `[]` because `referenceList(...).optional()` has no `.min(1)`, so the project is created
with an explicit empty member set. Locally both error with "needs at least one value".
The host does not backstop status/lead either: both are `OptionalString`
(`linear-agent-project-writes.ts:57-58`).

## R5-06 — claimed P2 — the `--name="NAME"` / `--description="DESCRIPTION"` retry template instructs the agent to build a double-quoted shell line, which mangles or executes special characters

TARGET: `src/main/runtime/linear-project-write-recovery.ts:177-181` (the two quoted placeholders)
and `:163` (the instruction "replacing every UPPERCASE placeholder with the exact original text").

CLAIM: The code correctly keeps user text out of the emitted string, but it pre-supplies DOUBLE
quotes — the one quoting form that still interprets `$`, backtick, `\` and `"` — and gives the agent
no quoting rule. Measured by executing the substituted line through bash 5.3, zsh 5.9, sh, dash,
fish and pwsh 7 on a real machine, and against documented CRT/`CommandLineToArgvW` rules for cmd.exe:
- `Payments V2` -> correct on every shell (this is the case the fix targeted, and the only case the
  test at `linear-project-write-recovery.test.ts:144-153` models).
- `Q3 "stretch" goals` -> SILENTLY MANGLED to `Q3 stretch goals` on every shell.
- `` Ship `whoami` `` -> EXECUTES on bash/zsh/sh/dash; parse error on pwsh.
- `Payments $(id)` -> EXECUTES on bash, zsh, sh, dash, fish AND pwsh.
- `Payments $USER` -> expands (wrong text written to Linear).
- trailing `\` -> unterminated-quote syntax error on bash/zsh/sh/dash and fish; on cmd.exe the `\"`
  is a literal quote that does not close the run, so `--write-id` is swallowed into the description
  and the create SUCCEEDS WITHOUT a write id -> a duplicate project.
- `Sale 50%PATH%` -> expands on cmd.exe.
Descriptions are 255 chars of free prose that routinely contain Markdown code spans (backticks).
Scope note: the text originates from the user's own failed invocation, so this is not a privilege
boundary in the ordinary case; the practical harms are (a) silently wrong text written to Linear
and (b) a duplicate create on Windows. It becomes an injection path only if the description was
itself derived from untrusted content the agent had read. This is on the unconfirmed-write recovery
path only. The same file already solves this correctly for `content` and the update body by routing
them through stdin.

## R5-07 — claimed P2 — an empty occurrence inside a destructive collection replacement is silently dropped

TARGET: `src/cli/flags.ts:32-40` (`getRepeatedStringFlag` -> `.filter((entry) => entry.length > 0)`)
consumed by the NEW `src/cli/linear-project-edit-request.ts:173` (`readOptionalReferences`).

CLAIM: `src/cli/flags.ts` is NOT in this diff (pre-existing helper), but the new destructive-replace
consumer is. Executed: `orca linear project edit P --member "" --member ada` -> `{"members":["ada"]}`,
exit 0. So `--member "$LEAD" --member ada` with `LEAD` unset REPLACES the project's member list with
`{ada}` alone and drops the intended member, with no error. The module already fails closed when
EVERY value is empty (`--member=` -> "`--member replaces the whole collection and needs at least one
value`"), so the partial case is an inconsistency in the same guard, not an unconsidered default.

## R5-08 — claimed P2 — two behavior changes to pre-existing shipped commands, undocumented

TARGET: `src/cli/linear-request-builders.ts:288-297` and `:316-327`.
Base comparison: `git show 604169f4af:src/cli/linear-request-builders.ts` shows
`readLinearBodyFile` at base had NEITHER guard.

CLAIM: Both new guards sit in `readLinearBodyFile`, which is shared with the PRE-EXISTING
`orca linear comment add`, `orca linear create`, and `orca linear save-issue`
(`src/cli/handlers/linear.ts:217,251`, `src/cli/linear-save-issue-request.ts:28`):
(a) `rejectBlankLinearBodyFile` now throws `invalid_argument` for a whitespace-only `--body-file`
(path or `-`). A script piping a possibly-empty generated body now fails where it previously posted.
(b) `ORCA_CLI_SSH_REMOTE=1` (newly set for every host-CLI passthrough at
`src/main/ssh/ssh-remote-cli-host-passthrough.ts:166`) now makes a non-`-` `--body-file <path>`
throw `invalid_environment` over SSH. Note the counter-argument, which the coordinator finds
convincing: at base that same invocation resolved the remote's cwd against the DESKTOP HOST's
filesystem, so it either ENOENT'd or silently read and posted the wrong file — (b) is a fix, not a
regression. Neither change is mentioned in either skill guide or any release note.

## R5-09 — claimed P2 — UTF-8 BOM in a `--content-file` / `--body-file` becomes a literal U+FEFF in Linear

TARGET: `src/cli/linear-request-builders.ts:299` (`readFile(..., 'utf8')`, no BOM strip).

CLAIM: Executed end-to-end through the real `buildProjectEditRequest`: a file written by
`printf '\xEF\xBB\xBF# Title\r\n'` yields content whose first codepoint is `feff`. CRLF IS correctly
normalized on this path (verified), but the BOM is not stripped, and the repo has BOM strippers
elsewhere (`csv-parse.ts`, `skill-display-text.ts`). Windows editors (Notepad, PowerShell
`Out-File` / `>`) emit BOM'd UTF-8 by default, so `orca linear project create --content-file overview.md`
from PowerShell writes an invisible zero-width character as the first char of the project overview.
It also poisons `contentSha256` in the `linear_write_unconfirmed` recovery payload and the
`sameLinearProjectContent` no-op comparison, so a re-run can be reported as "changed" when it is not.
Also affects the pre-existing `--body-file` commands.

## R5-10 — claimed P2 — the text cap slices mid-UTF-16-surrogate, emitting a lone surrogate in `--json`

TARGET: `src/main/linear/linear-text-digest.ts:26` (`normalized.slice(0, cap)`).

CLAIM: Executed with a description of `'a'.repeat(19_999) + '😀' + 'tail'`: the bounded value's last
code unit is `0xd83d`, an unpaired high surrogate. Terminal output shows the replacement character;
`--json` emits `\ud83d` unpaired, which `serde_json` REJECTS outright and Go's `encoding/json`
silently replaces. Affects `project show` description/content, `project show --updates` bodies, and
every bounded field in the edit result. `chars` / `sha256` stay correct (they digest the full text),
so only the display value is affected. Fix is one line: back off a code unit when
`value.charCodeAt(cap - 1)` is a high surrogate.

## R5-11 — claimed P2 — the 256-reference cap cannot complete inside the 30s intent deadline

TARGET: `src/main/runtime/rpc/methods/linear-agent-project-writes.ts:40-47`
(`LINEAR_PROJECT_REFERENCE_CAP = 256`); sequential resolution at
`src/main/runtime/linear-project-edit-intent.ts:137-150` and
`src/main/runtime/linear-project-create-resolution.ts:71-84`;
deadline at `src/main/runtime/orca-runtime.ts:2043`.

CLAIM: Every user/team/label reference costs one HTTP round-trip issued STRICTLY sequentially
(`for (const input of inputs) { await resolve... }`), with zero overlap — measured by bundling the
real `resolveLinearProjectEditIntent` against a 20ms stubbed round-trip: 10 refs = 208ms,
50 = 1045ms, 256 = 5367ms, perfectly linear. Against the 30s deadline the per-request budget at the
schema's own cap is 30000/256 = 117ms, which is below realistic Linear latency, so a max-size
`--member` replacement reliably returns `linear_timeout` with nothing written. The cap is roughly 2x
beyond what the deadline can service. The comment at `:41-43` acknowledges the sequential cost but
picked a cap the deadline cannot honor. Smallest fix: bounded-concurrency map at 4 (matching the
shared limiter), or lower the cap.

---

## Candidates the coordinator investigated and DROPPED (do not rate; listed so seats do not re-raise them)

- Prior round's "content canonicalization is code-fence-blind so an edit can be silently discarded
  as noop": the canonicalizer (`src/main/linear/project-content-rewrites.ts:123-127`) does only four
  things — unwrap `](<dest>)`, unwrap `<http://x>`, collapse `[url](url)` to `url`, and `trimEnd()`.
  Executed against the real module: hard line breaks, nested-list indentation, blank lines, indented
  code blocks, heading spelling and list markers ALL compare as different and the write proceeds.
  Only a diff confined entirely to autolink SPELLING inside a code fence collapses. Near-zero
  frequency, and the user is told "no write was sent". Residual risk, not a finding.
- Prior round's "`resolveOneProjectLabel` drops `hasMore` and can resolve a duplicate label as
  unique": already fixed — `src/main/linear/project-write-references.ts:78-91` destructures
  `hasMore` and throws when true, the query is server-side filtered by `name: { eqIgnoreCase }`,
  and the bound is 10,000 same-named labels. Tests at `project-write-references.test.ts:139,166,188`.
- A reported `RangeError` escaping `safeParse` from the calendar-date refine: already fixed —
  `linear-agent-project-writes.ts:116-130` now uses `Date.UTC` with a comment naming that exact hazard.
- A reported `Object.prototype` bypass on `--health constructor`: already fixed —
  `src/shared/linear/project-agent-writes.ts:20-26` now guards with `Object.hasOwn`.
- `orca linear project create --content=` (emitted by the create retry command for a whitespace-only
  content) is ACCEPTED, not rejected: `readLinearContent`
  (`src/cli/linear-project-request-builders.ts:179-185`) exempts the inline form. Retry is runnable.
- `src/cli/linear-save-issue-request.ts` is genuinely untouched by this diff (empty `git diff`).
- CLI routing: a 1673-case old-vs-new differential over every pre-existing spec path x flag prefix
  found 0 differences; `orca linear project <typo>` gives "Unknown command ... Did you mean".
- SSH result classification cannot misread an issue result as a project result (all 22 fixtures).
- No new unsafe casts, no `as any`, no unchecked `JSON.parse`; every pagination walk has both a page
  cap and a cursor-progress check; every regex in the changed files was timed linear against 100k-char
  adversarial input (the earlier ReDoS fix holds); the content-rewrite cache is capped at 4 entries.
- Nothing new is persisted to disk; no existing RPC method's params or result changed; `mobile/`
  imports only `src/shared/linear/issue-types`, which is untouched — no mobile-facing surface.
- `npm run verify:bundled-skill-guides` exits 0.
