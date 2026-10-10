import React, { useMemo, useRef, useState } from 'react';
import type { TranscriptViewMessage } from '../../../ai/server/types';
import { isQuestionTool, partitionUnansweredQuestions, stripMcpPrefix } from '../../../ai/server/interactivePromptTools';
import { MaterialSymbol } from '../../icons/MaterialSymbol';
import { getSubagentDisplayName, isSiblingErroredTask } from '../utils/subagentDisplay';
import { getToolExpandId } from './TranscriptToolCard';

/**
 * Compact "Agents" strip above the transcript: one line per sub-agent with its
 * model, status and whether it is waiting on the user. Everything is derived
 * from the transcript messages already in memory.
 */

export type AgentStripStatus = 'running' | 'done' | 'failed' | 'stopped';

export interface AgentStripEntry {
  /** The id `expandedTools` is keyed by for this agent's card. */
  toolId: string;
  /** Index of the agent's message in the transcript. */
  messageIndex: number;
  name: string;
  model: string | null;
  status: AgentStripStatus;
  /** Unanswered question, permission and plan prompts anywhere under this agent. */
  pendingPromptIds: readonly string[];
}

/** Anything but a known in-flight or bad ending reads as finished. */
export function normalizeAgentStatus(raw: unknown): AgentStripStatus {
  return raw === 'running' || raw === 'failed' || raw === 'stopped' ? raw : 'done';
}

const NON_QUESTION_PROMPTS = new Set(['ToolPermission', 'ExitPlanMode']);

function collectDescendants(events: readonly TranscriptViewMessage[], out: TranscriptViewMessage[]): void {
  for (const event of events) {
    out.push(event);
    if (event.subagent?.childEvents) collectDescendants(event.subagent.childEvents, out);
  }
}

const bySequenceThenTime = (a: TranscriptViewMessage, b: TranscriptViewMessage): number =>
  Number.isFinite(a.sequence) && Number.isFinite(b.sequence)
    ? a.sequence - b.sequence
    : (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0);

export function deriveAgentStrip(messages: readonly TranscriptViewMessage[]): AgentStripEntry[] {
  const agents: Array<{ index: number; message: TranscriptViewMessage }> = [];
  messages.forEach((message, index) => {
    if (message.type === 'subagent' && message.subagent && !isSiblingErroredTask(message)) {
      agents.push({ index, message });
    }
  });
  if (agents.length === 0) return [];

  const descendantsOf = agents.map(({ message }) => {
    const out: TranscriptViewMessage[] = [];
    collectDescendants(message.subagent?.childEvents ?? [], out);
    return out;
  });

  // Questions a user turn has moved past are closed. Child events carry the same
  // session-wide sequence as the top-level rows, so order the user turns and
  // every nested question together and let the shared partition decide.
  const questionDescendants = descendantsOf.flat().filter(event => isQuestionTool(event.toolCall?.toolName));
  const openQuestionIds = new Set<string>();
  if (questionDescendants.length > 0) {
    const scan = [...messages.filter(m => m.type === 'user_message'), ...questionDescendants].sort(bySequenceThenTime);
    for (const question of partitionUnansweredQuestions(scan).open) openQuestionIds.add(question.id);
  }

  // A tool re-sent under the same id is one card; the last one wins.
  const byToolId = new Map<string, AgentStripEntry>();
  agents.forEach(({ index, message }, agentIdx) => {
    const pendingPromptIds: string[] = [];
    for (const event of descendantsOf[agentIdx]) {
      const call = event.toolCall;
      const id = call?.providerToolCallId;
      if (!call || !id || call.result) continue;
      const isPending = isQuestionTool(call.toolName)
        ? openQuestionIds.has(id)
        : NON_QUESTION_PROMPTS.has(stripMcpPrefix(call.toolName));
      if (isPending) pendingPromptIds.push(id);
    }
    const toolId = getToolExpandId(message, index);
    byToolId.set(toolId, {
      toolId,
      messageIndex: index,
      name: getSubagentDisplayName(message),
      model: message.subagent?.model || null,
      status: normalizeAgentStatus(message.subagent?.status),
      pendingPromptIds,
    });
  });
  return [...byToolId.values()];
}

const sameEntry = (a: AgentStripEntry, b: AgentStripEntry): boolean =>
  a.toolId === b.toolId && a.messageIndex === b.messageIndex && a.name === b.name && a.model === b.model &&
  a.status === b.status && a.pendingPromptIds.length === b.pendingPromptIds.length &&
  a.pendingPromptIds.every((id, i) => id === b.pendingPromptIds[i]);

/** Entries for the strip; keeps its identity across streamed frames that change nothing it shows. */
export function useAgentStripEntries(messages: readonly TranscriptViewMessage[]): AgentStripEntry[] {
  const derived = useMemo(() => deriveAgentStrip(messages), [messages]);
  const previousRef = useRef<AgentStripEntry[]>(derived);
  const previous = previousRef.current;
  if (previous !== derived && !(previous.length === derived.length && derived.every((entry, i) => sameEntry(entry, previous[i])))) {
    previousRef.current = derived;
  }
  return previousRef.current;
}

export function summarizeAgents(entries: readonly AgentStripEntry[]): string {
  const running = entries.filter(entry => entry.status === 'running').length;
  const noun = entries.length === 1 ? 'agent' : 'agents';
  return `${entries.length} ${noun}, ${running} running`;
}

const STATUS_CLASS: Record<AgentStripStatus, string> = {
  running: 'text-[var(--nim-primary)]',
  done: 'text-[var(--nim-success)]',
  failed: 'text-[var(--nim-error)]',
  stopped: 'text-[var(--nim-text-muted)]',
};

const NeedsAnswerBadge: React.FC = () => (
  <span
    className="agents-strip-needs-answer shrink-0 rounded-full bg-[var(--nim-primary)] px-1.5 text-[10px] font-medium text-[var(--nim-on-primary)]"
    data-testid="agents-strip-needs-answer"
  >
    needs your answer
  </span>
);

export interface AgentsStripProps {
  entries: readonly AgentStripEntry[];
  onSelect: (entry: AgentStripEntry) => void;
}

export const AgentsStrip = React.memo(function AgentsStrip({ entries, onSelect }: AgentsStripProps) {
  // null = follow the data: open while an agent is waiting on the user, else one summary line.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (entries.length === 0) return null;
  const waiting = entries.filter(entry => entry.pendingPromptIds.length > 0).length;
  const isOpen = userOpen ?? waiting > 0;

  return (
    <div
      className="agents-strip shrink-0 border-b border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-xs"
      data-testid="agents-strip"
    >
      <button
        type="button"
        className="agents-strip-summary flex w-full cursor-pointer items-center gap-1.5 border-none bg-transparent px-3 py-1 text-left text-[var(--nim-text-muted)] hover:text-[var(--nim-text)]"
        aria-expanded={isOpen}
        onClick={() => setUserOpen(!isOpen)}
      >
        <MaterialSymbol icon="cloud_sync" size={14} className="shrink-0 text-[var(--nim-primary)]" />
        <span className="agents-strip-summary-text font-medium">{summarizeAgents(entries)}</span>
        {!isOpen && waiting > 0 && <NeedsAnswerBadge />}
        <MaterialSymbol icon={isOpen ? 'expand_more' : 'chevron_right'} size={14} className="ml-auto shrink-0 text-[var(--nim-text-faint)]" />
      </button>
      {isOpen && (
        <ul className="agents-strip-list m-0 max-h-40 list-none overflow-y-auto p-0 pb-1">
          {entries.map(entry => (
            <li key={entry.toolId}>
              <button
                type="button"
                className="agents-strip-row flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 py-0.5 text-left text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
                data-testid="agents-strip-row"
                title={entry.name}
                onClick={() => onSelect(entry)}
              >
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.model && <span className="max-w-32 shrink-0 truncate text-[11px] text-[var(--nim-text-muted)]">{entry.model}</span>}
                {entry.pendingPromptIds.length > 0 && <NeedsAnswerBadge />}
                <span className={`agents-strip-status shrink-0 text-[11px] ${STATUS_CLASS[entry.status]}`} data-status={entry.status}>
                  {entry.status}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
