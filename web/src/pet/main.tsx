import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './pet.css'
import { Pet } from './Pet'

// Desktop pet entry (web/pet.html), macOS and Windows desktop only. Like the
// tray popup and the island it does NOT mount the SPA shell: no backend
// access, stores, or routing. Its data arrives from the shell over IPC.

// Bubbles follow the system appearance (the app's own theme pick lives in
// the app windows' storage).
const dark = window.matchMedia?.('(prefers-color-scheme: dark)')
const applyTheme = () => document.documentElement.classList.toggle('dark', Boolean(dark?.matches))
applyTheme()
dark?.addEventListener('change', applyTheme)

createRoot(document.getElementById('root')!).render(<Pet />)
