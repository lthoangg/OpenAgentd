import { createRoot } from 'react-dom/client'
import './tray.css'
import { TrayPopup } from './TrayPopup'

// Lightweight tray-popup entry (web/tray.html). Deliberately does NOT mount
// the full SPA shell — no SSE, stores, hotkeys, or deep-link routing.
createRoot(document.getElementById('root')!).render(<TrayPopup />)
