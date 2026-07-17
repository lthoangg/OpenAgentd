import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { installDesktopAuth } from './api/auth'
import { initTheme } from './lib/theme'

// Install the desktop session token interceptor *before* any other module
// has a chance to capture a reference to the original `window.fetch`.
installDesktopAuth()
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
