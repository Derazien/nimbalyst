import { dispatchSessionMetaTool } from "../../mcp/sessionNamingServer";

/**
 * Re-apply an `update_session_meta` call the agent transport announced but
 * never completed.
 *
 * Measured on one install: 13 of 3856 such calls (0.34%) ended this way, and
 * they cluster — one session dropped five consecutive calls over 22 minutes and
 * never recovered, so its phase and tags stayed at whatever the last successful
 * call had set. Nimbalyst's MCP server is not the cause; a stale connection
 * answers every request with a fast 404 rather than hanging.
 *
 * Everything needed is in the arguments the agent already announced, so this
 * routes them through the same dispatcher the MCP tool would have reached —
 * deliberately not back through the transport that just dropped the call.
 */
export async function repairOrphanedSessionMetaCall(
  toolCall: { name?: string; arguments?: unknown },
  sessionId: string | undefined
): Promise<void> {
  const tool = String(toolCall.name ?? "").replace(/^mcp__.+?__/, "");
  if (tool !== "update_session_meta") return;
  if (
    !sessionId ||
    !toolCall.arguments ||
    typeof toolCall.arguments !== "object"
  )
    return;

  try {
    await dispatchSessionMetaTool(
      tool,
      toolCall.arguments as Record<string, unknown>,
      sessionId
    );
    console.warn(
      `[SessionMeta] re-applied a dropped update_session_meta for session ${sessionId}`
    );
  } catch (err) {
    // Best effort. The agent is already gone; failing here must not disturb the
    // stream, but it must not be silent either -- silence is what made the
    // original drop take an hour to characterize.
    console.error(
      "[SessionMeta] could not re-apply a dropped update_session_meta:",
      err
    );
  }
}
