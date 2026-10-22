import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './island.css'
import { Island } from './Island'

// Notch island entry (web/island.html), macOS desktop only. Like the tray
// popup it does NOT mount the SPA shell: no backend access, stores, or
// routing. Its data arrives from the shell over IPC.
createRoot(document.getElementById('root')!).render(<Island />)
