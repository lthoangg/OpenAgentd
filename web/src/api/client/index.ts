/**
 * OpenAgentd API client — barrel re-exporting every domain group.
 *
 * Split from a single 1.2k-line client.ts; consumers keep importing
 * named symbols from '@/api/client'.
 */

export * from './_shared'
export * from './team'
export * from './observability'
export * from './misc'
export * from './agents'
export * from './scheduler'
export * from './mcp'
export * from './settings'
