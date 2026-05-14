import type { WorkerTurnRequest } from './worker-types.js';

export const TRANSCRIPT_CONTEXT_POLICY = 'ignored-by-current-stdin-contract';

export interface PreparedWorkerTurnInput {
  readonly isFirstTurn: boolean;
  readonly prompt: string;
  readonly transcriptPolicy: typeof TRANSCRIPT_CONTEXT_POLICY;
}

export function prepareWorkerTurnInput(
  request: Pick<WorkerTurnRequest, 'sessionId' | 'isFirstTurn' | 'projectRoot' | 'message' | 'seedContext' | 'transcript'>,
): PreparedWorkerTurnInput {
  const isFirstTurn = request.isFirstTurn ?? request.sessionId === null;
  return {
    isFirstTurn,
    prompt: request.message,
    transcriptPolicy: TRANSCRIPT_CONTEXT_POLICY,
  };
}
