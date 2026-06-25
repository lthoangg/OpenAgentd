export async function selectTrustedWorkspace(
  browserPath: string | null,
  validateTrustedWorkspace: (path: string) => Promise<string>,
): Promise<string | null> {
  if (!browserPath) return null
  return validateTrustedWorkspace(browserPath)
}

export function consumeTrustedWorkspace(
  trustWorkspace: string | null,
): { workspaceToOpen: string | null; nextTrustWorkspace: null; nextDialogOpen: boolean } {
  if (!trustWorkspace) {
    return {
      workspaceToOpen: null,
      nextTrustWorkspace: null,
      nextDialogOpen: true,
    }
  }
  return {
    workspaceToOpen: trustWorkspace,
    nextTrustWorkspace: null,
    nextDialogOpen: false,
  }
}
