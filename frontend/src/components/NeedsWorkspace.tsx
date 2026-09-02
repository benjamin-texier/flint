import { keptSentence } from '../lib/spaces'

/** The one place Flint explains its workspace.
 *
 *  There were seven, in four wordings. Three printed
 *  `` `FLINT_WORKSPACE_DATABASE` `` with the backticks showing, because they
 *  were written as markdown into JSX text; two mentioned that your own tables
 *  are untouched and five did not; one named four sections and another five, and
 *  `Home` had stopped being one of them months before any of the sentences
 *  noticed. Every one of those is the same defect: a fact about the deployment,
 *  restated by hand beside each page that happens to need it.
 *
 *  So it is a component, and the sections it promises come from the navigation
 *  table itself — see `keptSections`. What a reader is told will come back is
 *  what the bar will actually show.
 *
 *  **It is an offer, not a refusal.** This is the state a first run meets, and
 *  the difference between "this page cannot work" and "here is what one line
 *  turns on" is most of what somebody decides about the product in that minute.
 *  So the order is what is missing, what it brings, then how — with the caveat
 *  that matters (Flint writes its own tables and nothing else) stated once
 *  rather than in two pages out of seven.
 *
 *  Its own markup rather than `EmptyNote`'s, whose children are one paragraph:
 *  this is three, and three paragraphs separated by `<br /><br />` inside a `<p>`
 *  is a paragraph pretending. */
export function NeedsWorkspace({
  holds,
  title = 'Flint is running without a workspace',
}: {
  /** What this page cannot keep, with its article: `a dashboard`, `an alert or
   *  its history`. Written by the caller, because only the caller knows. */
  holds: string
  /** For a page whose own heading already says the rest. */
  title?: string
}) {
  return (
    <div className="note note--empty needsws">
      <p className="note__title">{title}</p>
      <p className="note__hint">
        Flint has nowhere to keep {holds}, and it will not create anything uninvited.
      </p>
      <p className="note__hint">
        Name a database it may write to and {keptSentence()} come back, along with saved
        statements on the Query page.
      </p>
      <pre className="needsws__env">FLINT_WORKSPACE_DATABASE=flint</pre>
      <p className="note__hint">
        Any database Flint&rsquo;s own account may create tables in — <code>flint</code> is the
        conventional name. It creates its own tables there and touches nothing else, so your
        data is the same either way. Restart to pick it up.
      </p>
    </div>
  )
}
