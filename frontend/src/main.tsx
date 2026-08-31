import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'

import { App } from './App'
import { reachAnswered, reachFailed, reachSnapshot } from './lib/reach'
import './styles/base.css'
import './styles/app.css'

/** A 401 from anywhere means the session is over.
 *
 *  Sessions end on their own — an idle timeout, a Flint that restarted — and
 *  the first anybody hears of it is an ordinary request failing in the middle
 *  of whatever they were doing. Re-asking who you are turns that into the
 *  sign-in screen, which is an answer, instead of an error toast on a page that
 *  will never load again.
 *
 *  Safe to fire on any 401: `/api/session` is the one route that never returns
 *  one, so this cannot loop. */
const sessionEnded = (error: unknown) => {
  if ((error as { status?: number })?.status === 401) {
    client.invalidateQueries({ queryKey: ['session'] })
  }
}

/** Whether the backend can be reached is a fact about the window, not about
 *  the query that happened to notice — so it is collected here, once, where
 *  every request already passes. `lib/reach` decides which failures qualify;
 *  the strip at the top of the app is the only thing that says so out loud. */
const watchReach = (error: unknown) => reachFailed(error)

/** Something answered while the window believed nothing would.
 *
 *  Clearing the flag is not enough on its own: every query that failed during
 *  the outage has exhausted its retries and will sit there until something asks
 *  it again, so the strip would vanish and leave a page of panels still saying
 *  they were waiting. The first answer is the signal to ask them all again —
 *  and only the first, since by then the outage is cleared and this does
 *  nothing, which is what keeps it from feeding itself. */
const watchRecovery = () => {
  if (reachSnapshot().outage === null) return
  reachAnswered()
  void client.invalidateQueries()
}

const client = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      sessionEnded(error)
      watchReach(error)
    },
    // Any answer at all means the backend is there. Cheap enough to run on
    // every success: it returns immediately unless something was wrong.
    onSuccess: () => watchRecovery(),
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      sessionEnded(error)
      watchReach(error)
    },
    onSuccess: () => watchRecovery(),
  }),
  defaultOptions: {
    queries: {
      // Schema metadata is cheap to re-read but changes rarely; refetching on
      // every focus makes the explorer feel jumpy.
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (attempt, error) => {
        // A 4xx will not fix itself.
        const status = (error as { status?: number })?.status ?? 0
        return status >= 500 || status === 0 ? attempt < 2 : false
      },
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
