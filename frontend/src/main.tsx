import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { App } from './App'
import './styles/base.css'
import './styles/app.css'

const client = new QueryClient({
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
