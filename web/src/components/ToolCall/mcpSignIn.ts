/**
 * The server named by an `mcp` call refused because it waits on the user's
 * sign-in. The words are the backend's (`appv3_core::MCP_SIGN_IN_NOTE`, as a
 * failed call is stored: `Error: …`); such an answer rides with the call
 * (`result_rides_inline`), so the row can offer Sign in.
 */
const REFUSED_FOR_SIGN_IN = /^Error: MCP server '([^']+)' is not ready \(needs sign-in: connect it in Settings → MCP\)/

export function mcpSignInServer(result: string | null | undefined): string | null {
  return result?.match(REFUSED_FOR_SIGN_IN)?.[1] ?? null
}
