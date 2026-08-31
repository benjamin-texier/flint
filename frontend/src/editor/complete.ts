/** The completion, wired to CodeMirror.
 *
 *  Everything that decides *what* to offer lives in `lib/complete`, which knows
 *  nothing about editors and is tested without one. This file is the adapter: it
 *  reads the document, asks that question, and translates the answer into
 *  CodeMirror's `Completion` shape. Keeping the split means the rules can be
 *  argued about in a test file rather than in a browser.
 *
 *  It is registered as an `override`, which switches off `lang-sql`'s own
 *  keyword-and-schema completion entirely. That is the point: two sources
 *  disagreeing about what belongs at the caret is how you end up with 1,500
 *  entries and none of them the column you wanted. */

import {
  acceptCompletion,
  autocompletion,
  snippetCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'

import { candidates, contextAt, type Candidate, type Source } from '../lib/complete'

/** CodeMirror's own icon vocabulary. A column gets `property` and a table
 *  `class` because those are the icons its default theme draws for them; the
 *  names are CodeMirror's, not ours. */
const ICON: Record<Candidate['kind'], string> = {
  clause: 'keyword',
  keyword: 'keyword',
  column: 'property',
  table: 'class',
  database: 'namespace',
  function: 'function',
  snippet: 'text',
}

/** `lib/complete` writes its placeholders as `#{}` so that nothing in the
 *  library has to know CodeMirror's snippet syntax. This is where they become
 *  `${}`, which is what CodeMirror reads. */
function asSnippet(template: string): string {
  return template.replace(/#\{([^}]*)\}/g, (_, name: string) => `\${${name}}`)
}

function toOption(candidate: Candidate): Completion {
  const base: Completion = {
    label: candidate.label,
    type: ICON[candidate.kind],
    // CodeMirror's boost runs -99…99 and is added to the fuzzy-match score;
    // ours runs 0…99 as a plain ranking, so it is centred here.
    boost: candidate.boost - 50,
    ...(candidate.detail ? { detail: candidate.detail } : null),
    ...(candidate.info ? { info: candidate.info } : null),
  }
  if (candidate.snippet) return snippetCompletion(asSnippet(candidate.insert ?? candidate.label), base)
  return { ...base, apply: candidate.insert ?? candidate.label }
}

/** Everything after the caret's word is unchanged as long as the typed text is
 *  still a word, so CodeMirror filters the same list rather than asking for a
 *  new one on every keystroke. */
const STILL_A_WORD = /^[\w$]*$/

export function flintCompletion(source: Source): Extension {
  return [
    autocompletion({
      override: [
        (context: CompletionContext): CompletionResult | null => {
          const doc = context.state.doc.toString()
          const ctx = contextAt(doc, context.pos)
          const list = candidates(ctx, source)
          if (list.length === 0) return null
          // Nothing useful to say where the caret is: better silence than a
          // menu of everything.
          if (!ctx.word.text && ctx.slot === 'other') return null
          return {
            from: ctx.word.from,
            options: list.map(toOption),
            validFor: STILL_A_WORD,
          }
        },
      ],
      activateOnTyping: true,
      icons: true,
      // Two lines of prose about PREWHERE is worth reading; a wall of it is not.
      maxRenderedOptions: 60,
    }),
    // Tab takes the highlighted completion. The brief for this page is "more tab
    // than SQL", and Tab is the key everybody already presses — CodeMirror only
    // binds Enter by default. It falls through when no menu is open, so Tab
    // still indents.
    Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
    openOnSeparator,
  ]
}

/** Open the menu after a space or a comma, not only after a letter.
 *
 *  CodeMirror opens its own menu once there is a word to filter on, which means
 *  the moment where the *choice* is widest — right after `GROUP BY `, where the
 *  answer is one of this table's columns and nothing else — is the one moment it
 *  says nothing. Typing a letter to find out what is available is exactly the
 *  keystroke this page is trying to save.
 *
 *  A separator is the trigger rather than every keystroke, so the menu appears
 *  between words and stays out of the way inside one. Deferred to a timeout
 *  because a transaction cannot be dispatched from inside an update. */
const openOnSeparator = EditorView.updateListener.of((update) => {
  if (!update.docChanged || !update.view.hasFocus) return
  let separator = false
  update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    const text = inserted.toString()
    // Ends with a separator rather than *is* one, so accepting `GROUP BY ` —
    // one insertion, trailing space and all — opens the menu on the columns that
    // clause now needs. Short insertions only: a pasted block ending in a
    // newline is not somebody asking what comes next.
    if (text.length <= 24 && /[ ,\n]$/.test(text)) separator = true
  })
  if (!separator) return
  setTimeout(() => startCompletion(update.view), 0)
})
