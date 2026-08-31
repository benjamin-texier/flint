/** The console's prompt, wired to CodeMirror.
 *
 *  The prompt is a CodeMirror view rather than an `<input>` or an xterm canvas,
 *  and the reason is completion. `lib/complete` already knows every table and
 *  column on the server and which of them belongs at the caret; an `<input>`
 *  would mean a second, worse implementation of that, and a terminal emulator
 *  would mean drawing the popup by hand on a canvas — and losing the browser's
 *  own selection, copy and paste on the way, which is the first thing anybody
 *  tries in a console.
 *
 *  So: no emulator. The look of a terminal, the mechanics of the web. */

import { completionStatus } from '@codemirror/autocomplete'
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'

export interface PromptKeys {
  /** Enter, with the whole line. */
  run: () => void
  /** Up and Down, at the edges of the document. -1 walks back. */
  history: (direction: -1 | 1) => void
  /** Ctrl+C on an empty selection. True when there was something to cancel —
   *  false lets the browser have the keystroke back. */
  cancel: () => boolean
  /** Escape, with no completion menu to close first. */
  hide: () => void
  /** Ctrl+L, as in every shell. */
  clear: () => void
}

/** Whether the caret sits on the first (or last) line of the prompt.
 *
 *  Up recalls history *only* from the top line, so a two-line statement can
 *  still be navigated with the arrow keys. This is what every shell with
 *  multi-line editing does, and getting it wrong makes the second line of a
 *  statement impossible to reach. */
function atEdge(view: EditorView, edge: 'first' | 'last'): boolean {
  const { state } = view
  const line = state.doc.lineAt(state.selection.main.head)
  return edge === 'first' ? line.number === 1 : line.number === state.doc.lines
}

export function promptKeymap(keys: PromptKeys): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: 'Enter',
        run: (view) => {
          // The completion menu owns Enter while it is up; taking it here would
          // run a half-typed table name.
          if (completionStatus(view.state) === 'active') return false
          keys.run()
          return true
        },
      },
      // The escape hatch for a statement that wants more than one line. Bound
      // explicitly because Enter above is unconditional.
      { key: 'Shift-Enter', run: () => false },
      {
        key: 'ArrowUp',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false
          if (!atEdge(view, 'first')) return false
          keys.history(-1)
          return true
        },
      },
      {
        key: 'ArrowDown',
        run: (view) => {
          if (completionStatus(view.state) === 'active') return false
          if (!atEdge(view, 'last')) return false
          keys.history(1)
          return true
        },
      },
      {
        key: 'Mod-c',
        run: (view) => {
          // Ctrl+C is copy in a browser and cancel in a terminal, and this
          // console is both. The selection decides, exactly as it does in
          // Windows Terminal: something selected means copy, nothing selected
          // means interrupt. Returning false hands the keystroke back to the
          // browser untouched, so copy stays the browser's own copy.
          if (!view.state.selection.main.empty) return false
          return keys.cancel()
        },
      },
      {
        // The browser puts the address bar on Ctrl+L; a terminal empties the
        // screen. Inside a focused prompt the terminal wins, which is the same
        // bargain every web console makes and the one people expect here.
        key: 'Mod-l',
        preventDefault: true,
        run: () => {
          keys.clear()
          return true
        },
      },
      {
        key: 'Escape',
        run: (view) => {
          if (completionStatus(view.state) !== null) return false
          keys.hide()
          return true
        },
      },
    ]),
  )
}

/** The prompt's dress. The editor's theme with its chrome taken off: no gutter,
 *  no frame, no ground of its own — it sits directly on the console's. */
export const promptTheme: Extension = EditorView.theme({
  '&': {
    fontSize: 'var(--size-data)',
    backgroundColor: 'transparent',
    color: 'var(--chalk)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-data)',
    fontVariantLigatures: 'none',
    lineHeight: '1.6',
    backgroundColor: 'transparent',
  },
  '.cm-content': { padding: '0', caretColor: 'var(--spark)' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--spark)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--spark-wash)',
  },
  '.cm-placeholder': { color: 'var(--chalk-faint)' },
  /* The completion popup opens *upwards* here more often than not — the prompt
     is at the bottom of the window — so it needs the same frame the editor's
     does or it reads as a floating fragment. */
  '.cm-tooltip': {
    backgroundColor: 'var(--slab-raised)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-pop)',
    fontFamily: 'var(--font-data)',
    fontSize: 'var(--size-data)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--spark-wash)',
    color: 'var(--chalk)',
  },
  '.cm-completionDetail': { color: 'var(--chalk-faint)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-completionIcon': { color: 'var(--chalk-faint)', opacity: '1' },
  '.cm-completionIcon-keyword::after': { content: '"§"' },
  '.cm-completionIcon-class::after': { content: '"▤"' },
  '.cm-completionIcon-namespace::after': { content: '"▣"' },
  '.cm-completionIcon-text::after': { content: '"¶"' },
})
