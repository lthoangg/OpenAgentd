/** Public brand assets used before and after React mounts.
 *
 * Keep the app icon on one stable URL: `index.html` needs it for the
 * pre-React boot screen, and importing a second source copy from React would
 * emit the same PNG twice into every Tauri bundle.
 */
export const OPENAGENTD_APP_ICON = '/brand-assets/openagentd-app-icon.png'
