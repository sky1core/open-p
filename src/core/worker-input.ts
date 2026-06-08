import type { WorkerTurnRequest } from './worker-types.js';
import { EXIT_CODES, OpenPError } from './errors.js';

export const TRANSCRIPT_CONTEXT_POLICY = 'ignored-by-current-stdin-contract';

export interface PreparedWorkerTurnInput {
  readonly isFirstTurn: boolean;
  readonly prompt: string;
  readonly transcriptPolicy: typeof TRANSCRIPT_CONTEXT_POLICY;
}

export function prepareWorkerTurnInput(
  request: Pick<WorkerTurnRequest, 'sessionId' | 'isFirstTurn' | 'projectRoot' | 'message' | 'seedContext' | 'transcript'>,
): PreparedWorkerTurnInput {
  const isFirstTurn = readRequiredFirstTurnFlag(request);
  return {
    isFirstTurn,
    prompt: request.message,
    transcriptPolicy: TRANSCRIPT_CONTEXT_POLICY,
  };
}

export function readRequiredFirstTurnFlag(request: Pick<WorkerTurnRequest, 'isFirstTurn'>): boolean {
  if (typeof request.isFirstTurn !== 'boolean') {
    throw new OpenPError('worker turn requires explicit isFirstTurn', EXIT_CODES.usage);
  }
  return request.isFirstTurn;
}
