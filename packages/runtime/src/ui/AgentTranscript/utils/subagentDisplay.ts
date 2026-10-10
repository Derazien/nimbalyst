import type { TranscriptViewMessage } from '../../../ai/server/types';

/**
 * Name shown for a sub-agent wherever the transcript has to say which agent
 * something belongs to (the Agents strip, "Question from agent ..."): its task
 * description, else the teammate name, else its agent type.
 */
export function getSubagentDisplayName(message: TranscriptViewMessage): string {
  const description = (message.toolCall?.arguments as Record<string, unknown> | undefined)?.description;
  if (typeof description === 'string' && description.trim()) return description.trim();
  const subagent = message.subagent;
  return subagent?.teammateName || subagent?.agentType || 'Agent';
}

const SIBLING_ERRORED_RESULT = /^\s*(<tool_use_error>)?\s*Sibling tool call errored\s*(<\/tool_use_error>)?\s*$/;

/**
 * A Task call cancelled as a sibling of a parallel spawn. It was never
 * started, so the transcript hides it.
 */
export function isSiblingErroredTask(message: TranscriptViewMessage): boolean {
  const tool = message.toolCall;
  if (!tool || tool.toolName !== 'Task' || !message.isError) return false;
  return typeof tool.result === 'string' && SIBLING_ERRORED_RESULT.test(tool.result);
}
