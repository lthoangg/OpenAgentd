import { useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Image } from 'lucide-react'

import { FileRefContext, type FileRefOpener } from '../FileRefLink'
import { WORKSPACE_FILES_STALE_MS, workspaceFileListQueryOptions } from '@/queries/workspace-files'
import { workspaceRelativePath } from '@/utils/file-refs'
import { TOOL_CHIP_CLASS } from './chipStyles'

/**
 * "View image" beside a finished image ``read``: opens the image in the
 * review dock. Shown only while the image is in the workspace listing the
 * dock opens files from, so the chip never leads to "File not found".
 */
export function ImageViewChip({ path }: { path: string }) {
  const opener = useContext(FileRefContext)
  const workspace = opener?.workspace
  const relative = workspace ? workspaceRelativePath(path, workspace) : null
  if (!opener || !workspace || !relative || !opener.canOpen({ path })) return null
  return <ListedImageChip opener={opener} workspace={workspace} path={relative} />
}

function ListedImageChip({ opener, workspace, path }: { opener: FileRefOpener; workspace: string; path: string }) {
  const { data: listed = false } = useQuery({
    ...workspaceFileListQueryOptions(workspace),
    staleTime: WORKSPACE_FILES_STALE_MS,
    select: (response) => response.files.some((file) => file.path === path && !file.deleted),
  })
  if (!listed) return null
  return (
    <button
      type="button"
      onClick={() => opener.open({ path })}
      title={`Open ${path} in the panel`}
      className={TOOL_CHIP_CLASS}
    >
      <Image size={11} aria-hidden="true" />
      View image
    </button>
  )
}
