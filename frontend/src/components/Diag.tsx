/** The scaffolding both diagnostic pages stand on.
 *
 *  Diagnostics used to be one page. It is two — Data asks what the statements
 *  did, Infrastructure asks what the server is doing — and these three pieces
 *  are the part that has no side to take: how a section reports being denied,
 *  and how a verdict is printed. Shared rather than copied, because the two
 *  pages saying "not available here" differently would read as two products
 *  built by different people, which is the one thing the split must not cause.
 *
 *  Every section can be individually unavailable, because on a locked-down role
 *  most of them are. That is why they load independently rather than as one
 *  request — a user granted `system.parts` but not `system.query_log` should
 *  still get the storage half of the page. */

import { useEffect, useState } from 'react'

import type { Level, Verdict } from '../lib/diagnose'
import { slugify } from '../lib/publish'
import { EmptyNote, ErrorNote, Loading } from './Note'

export type Q<T> = {
  data: T | undefined
  error: unknown
  isPending: boolean
  refetch: () => void
}

/** One wrapper so every section handles pending, error and "not granted" the
 *  same way — the third being the common case on a read-only role. */
export function Section({
  title,
  sub,
  q,
  children,
}: {
  title: string
  sub?: string
  q: Q<{ available: boolean; reason?: string }>
  children: React.ReactNode
}) {
  return (
    /* Addressable, so the index above can reach it and so a link to one section
       of a seven-screen page is a link somebody can send. `slugify` is the
       product's existing rule for turning a name into an address — the same one
       the published APIs use — rather than a second one invented here. */
    <section className="diag" id={slugify(title)}>
      <header className="diag__head">
        <h2 className="diag__title">{title}</h2>
        {sub ? <p className="diag__sub">{sub}</p> : null}
      </header>
      {q.isPending ? <Loading label="Reading system tables" /> : null}
      {q.error ? <ErrorNote error={q.error} retry={() => q.refetch()} /> : null}
      {q.data && !q.data.available ? (
        <EmptyNote title="Not available here">
          {q.data.reason}. Everything else on this page is unaffected.
        </EmptyNote>
      ) : null}
      {q.data?.available ? children : null}
    </section>
  )
}

export function Says({ verdict }: { verdict: Verdict }) {
  if (verdict.level === 'ok') return null
  return <span className={`says says--${verdict.level}`}>{verdict.says}</span>
}

export function Flag({ level, children }: { level: Level; children: React.ReactNode }) {
  return <span className={`flag flag--${level}`}>{children}</span>
}

/** What is on this page, and a way to reach it.
 *
 *  Health is twelve sections and a little over seven screens; Diagnose is six
 *  and four and a half. Both are pages somebody works *in* rather than reads
 *  through, and until now the only way to learn what a page held — or to reach
 *  the seventy-pixel section sitting between two of two thousand — was to scroll
 *  past everything else and hope.
 *
 *  The list is read from the page rather than declared beside it. Sections load
 *  independently and several do not render at all on a narrow grant, so a
 *  declared list would name rows the page does not have — a header counting what
 *  the list below it does not show, which is the one thing this codebase will
 *  not print. Read from the rendered page it cannot disagree. */
export function SectionIndex() {
  const [items, setItems] = useState<{ id: string; title: string }[]>([])

  useEffect(() => {
    const page = document.querySelector('.page--diagnose')
    if (!page) return
    /* Anchors are given here rather than assumed. Only three of Health's eleven
       sections come through `Section` above — the other eight are components
       that render their own `.diag`, each for its own good reasons — so a list
       built from `[id]` alone would quietly show three of eleven. Naming what is
       unnamed costs one attribute and makes every section addressable, however
       it was built and whoever builds the next one. */
    const read = () => {
      const taken = new Set()
      /* Every `<section>` that presents a heading, not only the `.diag` ones:
         Health opens with "Watched on this server", which is a `.section`, and
         an index that lists eleven of the twelve headings a reader can see is
         the kind of quiet omission this codebase counts as a bug. */
      const next = [...page.querySelectorAll('section')].flatMap((s) => {
        const title = s.querySelector('h2')?.textContent?.trim() ?? ''
        if (!title) return []
        let id = s.id || slugify(title)
        if (!id) return []
        // Two sections that slug alike would give the browser one address for
        // two places; the second takes a number rather than the first's anchor.
        let n = 2
        while (taken.has(id)) id = `${slugify(title)}-${n++}`
        taken.add(id)
        if (s.id !== id) s.id = id
        return [{ id, title }]
      })
      // Only when the set actually changed: the observer below watches a subtree
      // this component renders into, so an unconditional update would be a loop.
      setItems((prev) =>
        prev.length === next.length && prev.every((p, i) => p.id === next[i]?.id) ? prev : next,
      )
    }
    read()
    const watch = new MutationObserver(read)
    watch.observe(page, { childList: true, subtree: true })
    return () => watch.disconnect()
  }, [])

  // An index of two is furniture, not navigation.
  if (items.length < 3) return null

  return (
    <nav className="onpage" aria-label="Sections on this page">
      <span className="onpage__label">On this page</span>
      <ul className="onpage__list">
        {items.map((s) => (
          <li key={s.id}>
            <a className="onpage__link" href={`#${s.id}`}>
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

