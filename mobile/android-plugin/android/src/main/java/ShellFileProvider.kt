package app.openagentd.shell

import androidx.core.content.FileProvider

/** Distinct class so its manifest entry doesn't merge with the app template's FileProvider. */
class ShellFileProvider : FileProvider()
