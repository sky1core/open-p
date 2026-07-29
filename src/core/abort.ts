export interface OpenPAbortError extends Error {
  readonly name: 'AbortError';
  readonly code: 'ABORT_ERR';
  readonly interruptedReasoningContent: string | null;
}

export interface AbortableOperationOptions<T> {
  readonly signal?: AbortSignal;
  readonly interrupt: () => Promise<void> | void;
  readonly operation: () => Promise<T>;
  readonly getInterruptedDraft?: () => string | null;
  readonly awaitOperationAfterAbort?: boolean;
  readonly preserveOperationErrorAfterAbort?: (error: unknown) => boolean;
}

export function createAbortError(
  message = 'operation aborted',
  interruptedReasoningContent: string | null = null,
): OpenPAbortError {
  const error = new Error(message) as OpenPAbortError;
  Object.defineProperty(error, 'name', { value: 'AbortError' });
  Object.defineProperty(error, 'code', { value: 'ABORT_ERR' });
  Object.defineProperty(error, 'interruptedReasoningContent', { value: interruptedReasoningContent });
  return error;
}

export function isAbortError(error: unknown): error is OpenPAbortError {
  return (
    error instanceof Error &&
    error.name === 'AbortError' &&
    (error as { readonly code?: unknown }).code === 'ABORT_ERR'
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

export async function runAbortableOperation<T>(options: AbortableOperationOptions<T>): Promise<T> {
  const { signal } = options;
  throwIfAborted(signal);
  if (!signal) {
    return options.operation();
  }

  let abortListener: (() => void) | null = null;
  if (options.awaitOperationAfterAbort === true) {
    let deferredAbortError: OpenPAbortError | null = null;
    abortListener = () => {
      deferredAbortError = createAbortError(
        'operation aborted',
        options.getInterruptedDraft?.() ?? null,
      );
      void Promise.resolve(options.interrupt()).catch(() => undefined);
    };
    signal.addEventListener('abort', abortListener, { once: true });
    try {
      try {
        const result = await options.operation();
        if (deferredAbortError !== null) {
          throw deferredAbortError;
        }
        return result;
      } catch (error) {
        if (
          deferredAbortError !== null &&
          options.preserveOperationErrorAfterAbort?.(error) !== true
        ) {
          throw deferredAbortError;
        }
        throw error;
      }
    } finally {
      signal.removeEventListener('abort', abortListener);
    }
  }

  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      void Promise.resolve(options.interrupt()).catch(() => undefined);
      reject(createAbortError('operation aborted', options.getInterruptedDraft?.() ?? null));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });

  try {
    return await Promise.race([options.operation(), abortPromise]);
  } finally {
    if (abortListener) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}
