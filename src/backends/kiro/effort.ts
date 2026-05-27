import { EXIT_CODES, OpenPError } from '../../core/errors.js';

const KIRO_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function validateKiroReasoningEffort(reasoningEffort: string | null | undefined): string | null {
  const effort = reasoningEffort?.trim() || null;
  if (!effort) {
    return null;
  }
  if (!KIRO_REASONING_EFFORTS.has(effort)) {
    throw new OpenPError(`unsupported Kiro effort value: ${effort}`, EXIT_CODES.unsupportedOption);
  }
  return effort;
}
