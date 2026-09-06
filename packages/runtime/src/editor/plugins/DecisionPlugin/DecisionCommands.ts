import { createCommand, type LexicalCommand } from 'lexical';
import type { DecisionPayload } from './DecisionNode';

/** Inserts an authored question without sending it to anyone. */
export const INSERT_DECISION_COMMAND: LexicalCommand<DecisionPayload> =
  createCommand('INSERT_DECISION_COMMAND');
