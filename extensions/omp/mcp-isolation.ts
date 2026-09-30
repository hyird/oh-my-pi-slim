export const MCP_ISOLATION_ERROR_MARKER = "OMP child native MCP isolation failed";

export function mcpIsolationError(reason: string): string {
  return `${MCP_ISOLATION_ERROR_MARKER}: ${reason}`;
}
