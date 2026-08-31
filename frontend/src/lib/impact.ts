/** What a drop would break, and what it would lose.
 *
 *  The same graph the diagram draws, asked a different question. `Read by`
 *  answers "who uses this, and which of its columns" — an exploration question
 *  about the immediate neighbours. This answers "what breaks if it goes away",
 *  which is a decision, and it has to be transitive: a view over a view over the
 *  table breaks too, and a confirmation showing only the first hop understates the
 *  damage on exactly the schemas where it matters most.
 *
 *  Two kinds of certainty, kept apart, because conflating them is the worst thing
 *  this could do. `declared` is ClickHouse's own dependency list: the server will
 *  itself break. `inferred` is Flint reading definitions with something that is
 *  deliberately not a SQL parser — it can miss a reference built by string
 *  concatenation, and it can catch one inside a comment. */

export interface Dependent {
  qualified: string
  kind: string
  how: 'declared' | 'inferred'
}

export interface Impact {
  available: boolean
  reason?: string
  qualified: string
  rows: number
  bytes: number
  dependents: Dependent[]
  /** False when a grant stopped Flint from reading definitions, in which case an
   *  empty list means "unknown" and not "nothing". */
  complete: boolean
}

export function declared(impact: Impact | undefined): Dependent[] {
  return (impact?.dependents ?? []).filter((d) => d.how === 'declared')
}

export function inferred(impact: Impact | undefined): Dependent[] {
  return (impact?.dependents ?? []).filter((d) => d.how === 'inferred')
}

/** One sentence for the whole answer, or null when there is nothing to say.
 *
 *  Never "0 objects": a table nothing reads is the ordinary case, and a figure
 *  reporting it trains people to skip the line that matters. And never a number
 *  without its certainty — "5 objects would break" reads as a promise, where
 *  "3 will break, 2 more name it" is what Flint actually knows. */
export function verdict(impact: Impact | undefined): string | null {
  if (!impact?.available) return null
  if (!impact.complete) {
    return 'Flint cannot read the definitions on this server, so it cannot say what depends on this'
  }
  const sure = declared(impact).length
  const guessed = inferred(impact).length
  if (sure === 0 && guessed === 0) return null
  const parts: string[] = []
  if (sure) parts.push(`${sure} object${sure === 1 ? '' : 's'} would break`)
  if (guessed) {
    parts.push(
      sure
        ? `${guessed} more name${guessed === 1 ? 's' : ''} it`
        : `${guessed} object${guessed === 1 ? '' : 's'} name${guessed === 1 ? 's' : ''} it`,
    )
  }
  return parts.join(', ')
}
