/** A dashboard left on a wall.
 *
 *  Full screen is a browser API and two decisions. The API is the easy half; the
 *  decisions are what a wall needs that a desk does not, and both were measured
 *  before they were written.
 *
 *  - **The screen lock is not there on the deployment that needs it.**
 *    `navigator.wakeLock` requires a secure context. Measured on this machine:
 *    over `http://127.0.0.1` it is present and granted, and over
 *    `http://10.0.8.10` — a Flint on a LAN address, which is exactly how a wall
 *    display is served — `navigator.wakeLock` is `undefined` and reaching for it
 *    throws a `TypeError`. So it is asked for where it exists, never promised,
 *    and the reason is named where somebody might otherwise wonder why the
 *    screen went dark at midnight.
 *  - **The browser owns the exit.** Escape leaves full screen without going
 *    anywhere near a click handler, so the state has to follow
 *    `fullscreenchange` rather than whatever the button last did. A page that
 *    thinks it is still full screen after Escape is a page with its chrome
 *    missing and no way to get it back.
 */

/** What this browser can do about keeping the screen awake. */
export type Lock = 'available' | 'insecure' | 'unsupported'

/** Deliberately takes the objects rather than reading the globals, so the three
 *  answers can be exercised without three browsers. */
export function lockSupport(
  nav: { wakeLock?: unknown } | undefined,
  secure: boolean | undefined,
): Lock {
  if (nav && typeof nav === 'object' && 'wakeLock' in nav && nav.wakeLock) return 'available'
  // The order matters: an insecure context is *why* it is missing, and saying
  // "your browser does not support it" there would send somebody to the wrong
  // browser.
  return secure === false ? 'insecure' : 'unsupported'
}

/** What to say about it, or nothing where there is nothing worth saying.
 *
 *  Only on the wall itself, and only where it will not hold: a dashboard that
 *  announces a working screen lock is announcing the absence of a problem. */
export function saysLock(lock: Lock): string | null {
  switch (lock) {
    case 'available':
      return null
    case 'insecure':
      return 'This page is served over plain HTTP, so the browser will not let it keep the screen awake. Serve Flint over HTTPS and it will.'
    case 'unsupported':
      return 'This browser cannot keep the screen awake, so the display may sleep on its own.'
  }
}

/** The controls a wall hides.
 *
 *  Everything that changes the dashboard rather than reads it: nobody edits a
 *  wall, and a stray click on a screen behind a desk is a dashboard somebody
 *  else has to put back. What stays is what tells a passer-by *what they are
 *  looking at* — the range and the variables, readable and not editable, because
 *  a chart of "the last 7 days" that does not say so is a chart of nothing in
 *  particular. */
export const WALL_HIDES = ['arrange', 'schedule', 'refresh-picker', 'tile-controls'] as const
