/**
 * Shared failure-detection heuristic for a tool's raw result string.
 *
 * Every non-shell tool that raises funnels its error through
 * ``app/agent/agent_loop/tool_executor.py`` (and the outer guard in
 * ``app/agent/agent_loop/core.py::_run_tool``) as a plain ``"Error: ..."``
 * prefix. The shell tool instead frames outcomes as bracketed markers
 * (``[Succeeded]`` / ``[Failed ...]`` / ``[Timed out ...]``). Both
 * vocabularies must be recognised here — this single heuristic feeds the
 * ``ToolCall`` header's success/failure styling *and* per-tool result
 * renderers such as ``DiffView``, so a drift between them is exactly what
 * let a failed ``patch`` call render as if it had succeeded.
 */
export function isFailedResult(result: string | undefined): boolean {
  if (!result) return false
  const firstLine = result.trimStart().split('\n', 1)[0]?.toLowerCase() ?? ''
  return (
    firstLine.startsWith('[failed') ||
    firstLine.startsWith('[error') ||
    firstLine.startsWith('[timed out') ||
    firstLine.startsWith('error:') ||
    firstLine.includes('exit code 1') ||
    firstLine.includes('exit 1')
  )
}
