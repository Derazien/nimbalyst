import yaml from 'js-yaml';
import type { DecisionBlockSource, FeedbackAskType } from '@nimbalyst/collab-protocol';
import { createDecisionId, parseDecisionFence, serializeDecisionFence } from './decisionFence';

export interface DecisionDraftFields {
  question: string;
  type: FeedbackAskType;
  entries: string;
  seed: string;
}

/** Preserve the block id and unknown fields when an unsent question is edited. */
export function buildDecisionDraft(fields: DecisionDraftFields, previous?: DecisionBlockSource): string {
  if (previous?.sealed) throw new Error('A sealed decision cannot be rewritten as a draft.');
  const question = fields.question.trim();
  if (!question) throw new Error('Write a question.');
  const labels = fields.entries.split('\n').map((line) => line.trim()).filter(Boolean);
  if (['singleSelect', 'multiSelect', 'reorder'].includes(fields.type) && labels.length < 2) {
    throw new Error('Add at least two options, one per line.');
  }
  const raw: Record<string, unknown> = { ...previous?.raw, id: previous?.id ?? createDecisionId(), ask: question, type: fields.type, draft: false };
  // Type changes cannot accidentally carry constraints from the previous ask.
  for (const key of ['options', 'items', 'seed', 'min', 'max', 'step']) delete raw[key];
  if (['singleSelect', 'multiSelect', 'reorder'].includes(fields.type)) {
    raw[fields.type === 'singleSelect' ? 'options' : 'items'] = labels.map((label, index) => {
      const old = previous?.type === fields.type ? previous.entries[index] : undefined;
      return { ...old?.raw, id: old?.id ?? `option-${index + 1}`, label };
    });
  }
  if (fields.type === 'editText') raw.seed = fields.seed;
  if (fields.type === 'rating') Object.assign(raw, { min: 1, max: 5, step: 1 });
  const parsed = parseDecisionFence(yaml.dump(raw, { lineWidth: -1, noRefs: true }));
  if (!parsed) throw new Error('This question could not be created.');
  return serializeDecisionFence(parsed);
}

/** Conversion creates an editable placeholder, never a sent question. */
export function standaloneDecisionBlock(title: string): string {
  const content = buildDecisionDraft({ question: title || 'What should we decide?', type: 'confirm', entries: '', seed: '' });
  const source = parseDecisionFence(content)!;
  source.raw.draft = true;
  return `\`\`\`decision\n${serializeDecisionFence(source)}\n\`\`\``;
}

export function appendStandaloneDecision(markdown: string, title: string): string {
  return /^\s*```decision\s*$/m.test(markdown)
    ? markdown
    : `${markdown.trimEnd()}\n\n${standaloneDecisionBlock(title)}\n`;
}
