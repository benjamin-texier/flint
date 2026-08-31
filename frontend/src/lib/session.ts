/** Whether there is an app to show at all.
 *
 *  One line of logic, in `lib` and tested, because it is the only thing standing
 *  between a signed-out browser and the shell — and because it has *three*
 *  inputs where it looks like it has two. The third is "the answer has not
 *  arrived yet", and reading that as either of the others is a bug both ways:
 *  as admitted, the app renders and fires a request that is guaranteed to be
 *  refused; as refused, a deployment nobody signs into flashes a sign-in screen
 *  at everybody who has never needed one. */

import type { Session } from './api'

/** True only when there is a person, or when this deployment asks for none. */
export function admits(session: Session | undefined): boolean {
  if (!session) return false
  return !session.required || Boolean(session.user)
}

/** Who to name in the interface — the signed-in user, else the account Flint
 *  itself connects as.
 *
 *  Null in exactly one state: nobody signed in to an *unpinned* Flint, which has
 *  no account of its own to fall back to. Nothing that renders this is on screen
 *  there — `admits` is false — but the type says so rather than asserting a
 *  name that does not exist. */
export function actingAs(session: Session | undefined): string | null {
  if (!session) return null
  return session.user ?? session.service_user
}
