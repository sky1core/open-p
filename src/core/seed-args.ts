import { EXIT_CODES, OpenPError } from './errors.js';
import { isSafeSessionId } from './session-id.js';

export interface SeedCliOptions {
  readonly backend: string;
  readonly historyPath: string;
  readonly resume: boolean;
  readonly backendSessionId: string | null; // non-null only in resume (append) mode
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly timeoutMs: number; // 0 = disabled (same meaning as the turn CLI)
}

// A dedicated small parser for `openp seed`. It is intentionally separate from the turn parser
// (`parseCliArgs`) so the existing turn-parsing behavior stays untouched. The value flags below are
// the only ones seed accepts; anything else is rejected the same way the turn parser rejects it.
const VALUE_FLAGS = new Set(['--history', '--resume', '--model', '--effort', '--timeout']);

export function parseSeedArgs(argv: readonly string[], knownBackends: ReadonlySet<string>): SeedCliOptions {
  let backend: string | null = null;
  let historyPath: string | null = null;
  let resume = false;
  let backendSessionId: string | null = null;
  let model: string | null = null;
  let reasoningEffort: string | null = null;
  let timeoutMs = 0;
  let timeoutSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('-')) {
      if (backend === null) {
        if (!knownBackends.has(arg)) {
          const available = [...knownBackends].join(', ');
          throw new OpenPError(`unknown backend: ${arg} (available: ${available})`, EXIT_CODES.unsupportedOption);
        }
        backend = arg;
        continue;
      }
      throw new OpenPError(`unexpected argument: ${arg}`, EXIT_CODES.usage);
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new OpenPError(`unsupported option: ${arg}`, EXIT_CODES.unsupportedOption);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-') || value.length === 0) {
      throw new OpenPError(`missing value for ${arg}`, EXIT_CODES.usage);
    }
    i += 1;
    switch (arg) {
      case '--history':
        historyPath = value;
        break;
      case '--resume':
        if (!isSafeSessionId(value)) {
          throw new OpenPError('invalid --resume: expected safe session id', EXIT_CODES.usage);
        }
        backendSessionId = value;
        resume = true;
        break;
      case '--model':
        model = value;
        break;
      case '--effort':
        reasoningEffort = value;
        break;
      case '--timeout':
        timeoutMs = parseTimeoutMs(value);
        timeoutSeen = true;
        break;
    }
  }

  if (backend === null) {
    const available = [...knownBackends].join(', ');
    throw new OpenPError(`backend is required: specify as first argument (available: ${available})`, EXIT_CODES.usage);
  }
  if (historyPath === null) {
    throw new OpenPError('--history <path> is required', EXIT_CODES.usage);
  }
  if (resume && (model !== null || reasoningEffort !== null || timeoutSeen)) {
    throw new OpenPError(
      '--model, --effort, and --timeout apply only when creating a session, not with --resume',
      EXIT_CODES.usage,
    );
  }

  return { backend, historyPath, resume, backendSessionId, model, reasoningEffort, timeoutMs };
}

// Parity with parseTimeoutMs in cli-args.ts: seconds -> ceil(ms); 0 disables; reject non-finite or
// negative. Duplicated (not imported) to keep the turn CLI parser untouched; kept identical on purpose.
function parseTimeoutMs(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new OpenPError(`invalid timeout: ${value}`, EXIT_CODES.usage);
  }
  return Math.ceil(seconds * 1000);
}
