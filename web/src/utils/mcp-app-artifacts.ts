import type { ContentBlock } from '@/api/types'

type BlockWithMCPApp = ContentBlock & {
  extra?: {
    mcp_app?: {
      resourceUri?: unknown
    }
  } | null
}

export function mcpAppResourceUri(block: ContentBlock): string | null {
  const resourceUri = (block as BlockWithMCPApp).extra?.mcp_app?.resourceUri
  return typeof resourceUri === 'string' && resourceUri.length > 0 ? resourceUri : null
}

export function latestMCPAppResourceBlockIds(blocks: ContentBlock[]): Set<string> {
  return new Set(latestMCPAppResources(blocks).values())
}

/** Index finalized app results once; live blocks are applied separately while
 * streaming so each SSE delta does not scan the complete session history. */
export function latestMCPAppResources(blocks: ContentBlock[]): Map<string, string> {
  const latestByResourceUri = new Map<string, string>()
  for (const block of blocks) {
    if (block.type !== 'tool' || !block.toolDone) continue
    const resourceUri = mcpAppResourceUri(block)
    if (resourceUri) latestByResourceUri.set(resourceUri, block.id)
  }
  return latestByResourceUri
}

export function latestMCPAppResourceBlockIdsFromParts(
  finalizedResources: ReadonlyMap<string, string>,
  currentBlocks: ContentBlock[],
): Set<string> {
  const latestByResourceUri = new Map(finalizedResources)
  for (const block of currentBlocks) {
    if (block.type !== 'tool' || !block.toolDone) continue
    const resourceUri = mcpAppResourceUri(block)
    if (resourceUri) latestByResourceUri.set(resourceUri, block.id)
  }
  return new Set(latestByResourceUri.values())
}
