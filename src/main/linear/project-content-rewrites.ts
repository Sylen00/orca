/**
 * Linear rewrites `Project.content` Markdown as it stores it, so a write never
 * reads back byte-identical to what was sent. Observed against the live API:
 *
 * - a bare `https://x` becomes `[https://x](<https://x>)`
 * - a bare `www.x` becomes `[www.x](<http://www.x>)`
 * - every link destination is wrapped in angle brackets: `[t](/rel)` -> `[t](</rel>)`
 * - trailing whitespace is stripped
 *
 * These rewrites are stable: writing a stored value back is a no-op. This module
 * models them so no-op detection and read-back verification compare intent
 * rather than spelling.
 *
 * Clearing is the one case where it also changes what is sent. Linear silently
 * ignores a `content` write of `null` or `""` — the mutation reports success and
 * the old body survives — but stores whitespace-only content as `""`. So a clear
 * travels as a single space, and an emptied body reads back as `""` and never
 * returns to `null`.
 */

const ANGLE_WRAPPED_DESTINATION = /\]\(<([^>]*)>\)/g
const ANGLE_AUTOLINK = /<(https?:\/\/[^>\s]+)>/g
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]*)\)/g

/**
 * Collapses only the distinctions Linear itself collapses, so two values that
 * canonicalize alike are guaranteed to store alike.
 */
export function canonicalizeLinearProjectContent(value: string): string {
  return value
    .replace(ANGLE_WRAPPED_DESTINATION, ']($1)')
    .replace(ANGLE_AUTOLINK, '$1')
    .replace(MARKDOWN_LINK, (link, label: string, destination: string) =>
      isAutolinkOf(label, destination) ? label : link
    )
    .replace(/\s+$/, '')
}

/** True when the link only restates its own label, which is what an autolink is. */
function isAutolinkOf(label: string, destination: string): boolean {
  return (
    destination === label || destination === `http://${label}` || destination === `https://${label}`
  )
}

/** A project with no overview: never set, explicitly cleared, or whitespace-only. */
export function isClearedLinearProjectContent(value: string | null): boolean {
  return value === null || canonicalizeLinearProjectContent(value) === ''
}

/** Compares content intent, not spelling; every empty form counts as the same clear. */
export function sameLinearProjectContent(left: string | null, right: string | null): boolean {
  if (isClearedLinearProjectContent(left) || isClearedLinearProjectContent(right)) {
    return isClearedLinearProjectContent(left) && isClearedLinearProjectContent(right)
  }
  return (
    canonicalizeLinearProjectContent(left as string) ===
    canonicalizeLinearProjectContent(right as string)
  )
}

/**
 * The value the mutation must carry. A clear becomes a single space because
 * Linear drops `null` and `""` on the floor without failing the write.
 */
export function linearProjectContentWriteValue(value: string | null): string {
  return isClearedLinearProjectContent(value) ? ' ' : (value as string)
}
