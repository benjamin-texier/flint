/** Which side of a sideways-scrolling strip still has something on it.
 *
 *  Flint's wide tables and its thirteen-tab strip both scroll horizontally
 *  inside their own box, which is the right layout and a silent one: the
 *  reader of `/db/default` was being shown seven of the object list's ten
 *  columns and had no way to learn that Ratio and Share existed. The house
 *  rule is that every fold states its own count, and a fold along the x-axis
 *  is still a fold — so the strip shades the side that continues.
 *
 *  A pure function over three numbers, because the interesting part is the
 *  arithmetic at the ends and that is testable without a browser: a scroller
 *  that has never been touched must report *right* and not *left*, and one
 *  scrolled to its end must report the reverse.
 */
export type Edges = { left: boolean; right: boolean }

export const NO_EDGES: Edges = { left: false, right: false }

/** Sub-pixel layout means `scrollLeft + clientWidth` lands a fraction short of
 *  `scrollWidth` at the true end of a scroller — a browser zoom or a fractional
 *  container width is enough. Under this many pixels there is nothing a reader
 *  could see, so it is not an edge. */
const SLACK = 2

export function edgesOf(scrollLeft: number, clientWidth: number, scrollWidth: number): Edges {
  if (scrollWidth - clientWidth <= SLACK) return NO_EDGES
  return {
    left: scrollLeft > SLACK,
    right: scrollLeft + clientWidth < scrollWidth - SLACK,
  }
}

/** The class the wrapper wears, so the CSS holds the appearance and this file
 *  holds only the question of which sides continue. */
export function edgeClass(edges: Edges): string {
  return `${edges.left ? ' is-more-left' : ''}${edges.right ? ' is-more-right' : ''}`
}

/** What a screen reader is told about the region, since the shade says it only
 *  to somebody who can see it. Named after what is inside rather than after the
 *  gesture: "Objects, scrolls sideways" is a description of this table, where
 *  "scrollable region" is a description of every one of them. */
export function edgeLabel(what: string, edges: Edges): string {
  return edges.left || edges.right ? `${what}, scrolls sideways` : what
}
