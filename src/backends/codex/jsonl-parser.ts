import { createHash } from 'node:crypto';

import type { AssistantEventSnapshot } from '../../core/types.js';
import { isSafeSessionId } from '../../core/session-id.js';

export interface CodexParsedOutput {
  readonly content: string | null;
  readonly reasoningContent: string | null;
  readonly sessionId: string | null;
  readonly assistantEvents: readonly AssistantEventSnapshot[];
  readonly usage: CodexParsedUsage;
}

export interface CodexParsedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadInputTokens: number | null;
}

export interface CodexStreamCallbacks {
  readonly onAssistantText?: (accumulatedText: string) => void;
  readonly onReasoningText?: (accumulatedText: string) => void;
  readonly onAssistantSnapshot?: (snapshot: AssistantEventSnapshot) => void;
}

export interface CodexStreamState {
  assistantText: string;
  reasoningText: string;
  lastAssistantText: string | null;
  lastAgentMessageMirrorCandidate: CodexAgentMessageMirrorCandidate | null;
  assistantEventSequence: number;
  streamFinalAssistantText: boolean;
}

interface CodexAgentMessageMirrorCandidate {
  readonly phase: string;
  readonly text: string;
}

export function parseCodexJsonlLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // non-JSON line
  }
  return null;
}

export function parseCodexOutput(stdout: string, lastMessageFileContent: string | null): CodexParsedOutput {
  const events = parseAllEvents(stdout);
  return extractFromEvents(events, stdout, lastMessageFileContent);
}

export function extractCodexSessionIdFromLine(line: string): string | null {
  const event = parseCodexJsonlLine(line);
  if (!event) return null;
  const type = event.type as string | undefined;
  if (type === 'thread.started' && typeof event.thread_id === 'string') {
    const candidateId = event.thread_id.trim();
    return candidateId && isSafeSessionId(candidateId) ? candidateId : null;
  }
  if (type === 'turn.completed' && typeof event.session_id === 'string') {
    const candidateId = event.session_id.trim();
    return candidateId && isSafeSessionId(candidateId) ? candidateId : null;
  }
  return null;
}

function parseAllEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseCodexJsonlLine(line);
    if (event) events.push(event);
  }
  return events;
}

function extractFromEvents(
  events: Record<string, unknown>[],
  rawStdout: string,
  lastMessageFileContent: string | null,
): CodexParsedOutput {
  let content: string | null = null;
  let sessionId: string | null = null;
  let usage: CodexParsedUsage = { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };
  const reasoningParts: string[] = [];
  const assistantEvents: AssistantEventSnapshot[] = [];
  let lastResponseItemText: string | null = null;
  let lastAgentMessageMirrorCandidate: CodexAgentMessageMirrorCandidate | null = null;
  let assistantEventSequence = 0;
  const nextAssistantEventId = (nativeId: unknown): string => {
    if (typeof nativeId === 'string' && nativeId.trim()) {
      return nativeId.trim();
    }
    assistantEventSequence += 1;
    return `seq_${assistantEventSequence}`;
  };
  const pushVisibleAssistantSnapshot = (text: string, phase: unknown): void => {
    if (!isVisibleAssistantMessagePhase(phase)) {
      return;
    }
    assistantEvents.push(buildAssistantSnapshot(text, String(phase), nextAssistantEventId(null)));
  };
  const pushAnswerSnapshot = (text: string, phase: unknown, nativeId: unknown): void => {
    assistantEvents.push(buildAssistantAnswerSnapshot(text, phase, nextAssistantEventId(nativeId)));
  };

  for (const event of events) {
    const type = event.type as string | undefined;

    if (type === 'thread.started') {
      if (!sessionId && typeof event.thread_id === 'string') {
        const candidateId = event.thread_id.trim();
        if (candidateId && isSafeSessionId(candidateId)) {
          sessionId = candidateId;
        }
      }
      continue;
    }

    if (type === 'turn.completed') {
      if (typeof event.result === 'string' && event.result.trim()) {
        content = event.result.trim();
      }
      if (typeof event.session_id === 'string') {
        const candidateId = event.session_id.trim();
        if (candidateId && isSafeSessionId(candidateId)) {
          sessionId = candidateId;
        }
      }
      usage = extractUsageFromTurnCompleted(event);
      continue;
    }

    if (type === 'response_item') {
      const payload = asObject(event.payload);
      if (!payload) continue;

      if (payload.type === 'reasoning') {
        lastAgentMessageMirrorCandidate = null;
        const text = extractReasoningSummaryText(payload);
        if (text) reasoningParts.push(text);
        continue;
      }

      if (payload.type === 'message' && payload.role === 'assistant') {
        const text = extractMessageOutputText(payload);
        if (text) {
          if (isCodexAgentMessageMirror(lastAgentMessageMirrorCandidate, payload.phase, text)) {
            lastAgentMessageMirrorCandidate = null;
            continue;
          }
          lastAgentMessageMirrorCandidate = null;
          if (isFinalResponsePhase(payload.phase)) {
            lastResponseItemText = text;
            pushAnswerSnapshot(text, payload.phase, payload.id);
          } else if (isVisibleAssistantMessagePhase(payload.phase)) {
            pushVisibleAssistantSnapshot(text, payload.phase);
          }
        }
        lastAgentMessageMirrorCandidate = null;
        continue;
      }
      lastAgentMessageMirrorCandidate = null;
      const toolSnapshot = buildCodexToolSnapshot(payload, type);
      if (toolSnapshot) {
        assistantEvents.push(toolSnapshot);
      }
      continue;
    }

    if (type === 'event_msg') {
      const payload = asObject(event.payload);
      if (!payload) continue;
      if (payload.type === 'agent_message') {
        if (typeof payload.message === 'string' && payload.message.trim()) {
          const text = payload.message.trim();
          if (isFinalResponsePhase(payload.phase)) {
            lastResponseItemText = text;
            pushAnswerSnapshot(text, payload.phase, payload.id);
          } else if (isVisibleAssistantMessagePhase(payload.phase)) {
            pushVisibleAssistantSnapshot(text, payload.phase);
          }
          lastAgentMessageMirrorCandidate = buildCodexAgentMessageMirrorCandidate(payload.phase, text);
        }
        continue;
      }
      lastAgentMessageMirrorCandidate = null;
      const toolSnapshot = buildCodexToolSnapshot(payload, type);
      if (toolSnapshot) {
        assistantEvents.push(toolSnapshot);
      }
      continue;
    }

    if (type === 'item.started' || type === 'item.completed') {
      lastAgentMessageMirrorCandidate = null;
      const item = asObject(event.item);
      if (!item) continue;
      const text = extractAgentMessageText(item);
      if (text) {
        if (isFinalResponsePhase(item.phase)) {
          lastResponseItemText = text;
          pushAnswerSnapshot(text, item.phase, item.id);
        } else if (isVisibleAssistantMessagePhase(item.phase)) {
          assistantEvents.push(buildAssistantSnapshot(text, String(item.phase), nextAssistantEventId(item.id)));
        }
        continue;
      }
      const toolSnapshot = buildCodexToolSnapshot(item, type);
      if (toolSnapshot) {
        assistantEvents.push(toolSnapshot);
      }
      continue;
    }
  }

  if (!content) {
    content = lastResponseItemText;
  }
  if (!content && lastMessageFileContent?.trim()) {
    content = lastMessageFileContent.trim();
  }
  if (!content && events.length === 0) {
    content = extractFallbackContent(rawStdout);
  }

  return {
    content,
    reasoningContent: reasoningParts.length > 0 ? reasoningParts.join('\n\n') : null,
    sessionId,
    assistantEvents,
    usage,
  };
}

function extractUsageFromTurnCompleted(event: Record<string, unknown>): CodexParsedUsage {
  const usage = asObject(event.usage);
  if (!usage) return { inputTokens: null, outputTokens: null, cacheReadInputTokens: null };

  return {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
    cacheReadInputTokens: typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : null,
  };
}

function extractReasoningSummaryText(payload: Record<string, unknown>): string | null {
  const summaryArr = payload.summary;
  if (!Array.isArray(summaryArr)) return null;

  const parts: string[] = [];
  for (const item of summaryArr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (typeof record.text === 'string' && record.text.trim()) {
        parts.push(record.text.trim());
      }
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function extractMessageOutputText(payload: Record<string, unknown>): string | null {
  const contentArr = payload.content;
  if (!Array.isArray(contentArr)) return null;

  const parts: string[] = [];
  for (const block of contentArr) {
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const record = block as Record<string, unknown>;
      if (record.type === 'output_text' && typeof record.text === 'string' && record.text.trim()) {
        parts.push(record.text.trim());
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function extractAgentMessageText(item: Record<string, unknown>): string | null {
  return item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()
    ? item.text.trim()
    : null;
}

function extractFallbackContent(rawStdout: string): string | null {
  const stripped = rawStdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return stripped || null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function processCodexStdoutLine(
  line: string,
  state: CodexStreamState,
  callbacks: CodexStreamCallbacks,
): void {
  const event = parseCodexJsonlLine(line);
  if (!event) return;

  const type = event.type as string | undefined;

  if (type === 'response_item') {
    const payload = asObject(event.payload);
    if (!payload) return;

    if (payload.type === 'reasoning') {
      state.lastAgentMessageMirrorCandidate = null;
      const text = extractReasoningSummaryText(payload);
      if (text) {
        state.reasoningText += (state.reasoningText ? '\n\n' : '') + text;
        callbacks.onReasoningText?.(state.reasoningText);
      }
      return;
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = extractMessageOutputText(payload);
      if (text) {
        if (isCodexAgentMessageMirror(state.lastAgentMessageMirrorCandidate, payload.phase, text)) {
          state.lastAgentMessageMirrorCandidate = null;
          return;
        }
        state.lastAgentMessageMirrorCandidate = null;
        if (isFinalResponsePhase(payload.phase)) {
          appendAssistantText(state, callbacks, text, {
            publish: state.streamFinalAssistantText,
          });
        } else if (isVisibleAssistantMessagePhase(payload.phase)) {
          appendAssistantText(state, callbacks, text);
          emitAssistantSnapshot(callbacks, text, payload.phase, nextCodexAssistantEventId(state, payload.id));
        }
      }
      state.lastAgentMessageMirrorCandidate = null;
      return;
    }
    state.lastAgentMessageMirrorCandidate = null;
    const toolSnapshot = buildCodexToolSnapshot(payload, type);
    if (toolSnapshot) {
      emitAssistantSnapshotObject(callbacks, toolSnapshot);
      return;
    }
    return;
  }

  if (type === 'event_msg') {
    const payload = asObject(event.payload);
    if (!payload) return;
    if (payload.type === 'agent_message') {
      if (typeof payload.message === 'string' && payload.message.trim()) {
        const text = payload.message.trim();
        if (isFinalResponsePhase(payload.phase)) {
          appendAssistantText(state, callbacks, text, {
            publish: state.streamFinalAssistantText,
          });
        } else if (isVisibleAssistantMessagePhase(payload.phase)) {
          appendAssistantText(state, callbacks, text);
          emitAssistantSnapshot(callbacks, text, payload.phase, nextCodexAssistantEventId(state, payload.id));
        }
        state.lastAgentMessageMirrorCandidate = buildCodexAgentMessageMirrorCandidate(payload.phase, text);
      }
      return;
    }
    state.lastAgentMessageMirrorCandidate = null;
    const toolSnapshot = buildCodexToolSnapshot(payload, type);
    if (toolSnapshot) {
      emitAssistantSnapshotObject(callbacks, toolSnapshot);
    }
    return;
  }

  if (type === 'item.started' || type === 'item.completed') {
    state.lastAgentMessageMirrorCandidate = null;
    const item = asObject(event.item);
    if (!item) return;
    const toolSnapshot = buildCodexToolSnapshot(item, type);
    if (toolSnapshot) {
      emitAssistantSnapshotObject(callbacks, toolSnapshot);
      return;
    }
    const text = extractAgentMessageText(item);
    if (!text) return;
    if (isFinalResponsePhase(item.phase)) {
      appendAssistantText(state, callbacks, text, {
        publish: state.streamFinalAssistantText,
      });
    } else if (isVisibleAssistantMessagePhase(item.phase)) {
      appendAssistantText(state, callbacks, text);
      emitAssistantSnapshot(callbacks, text, item.phase, nextCodexAssistantEventId(state, item.id));
    }
  }
}

function emitAssistantSnapshot(
  callbacks: Pick<CodexStreamCallbacks, 'onAssistantSnapshot'>,
  text: string,
  phase: unknown,
  messageId: string,
): void {
  if (!text || !isVisibleAssistantMessagePhase(phase)) {
    return;
  }
  callbacks.onAssistantSnapshot?.(buildAssistantSnapshot(text, phase, messageId));
}

function emitAssistantSnapshotObject(
  callbacks: Pick<CodexStreamCallbacks, 'onAssistantSnapshot'>,
  snapshot: AssistantEventSnapshot,
): void {
  callbacks.onAssistantSnapshot?.(snapshot);
}

export function buildAssistantSnapshot(text: string, phase: string, nativeId: string): AssistantEventSnapshot {
  return {
    semanticKind: phase === 'progress' ? 'progress' : 'commentary',
    message: {
      id: buildCodexMessageId(phase, nativeId),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
}

export function buildAssistantAnswerSnapshot(text: string, phase: unknown, nativeId: string): AssistantEventSnapshot {
  const phaseLabel = typeof phase === 'string' && phase.trim() ? phase.trim() : 'answer';
  return {
    message: {
      id: buildCodexMessageId(phaseLabel, nativeId),
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
}

function buildCodexMessageId(phase: string, nativeId: string): string {
  return `msg_${createHash('sha256').update(`codex:${phase}:${nativeId}`).digest('hex')}`;
}

export function buildCodexToolSnapshot(
  payload: Record<string, unknown>,
  eventType?: string,
): AssistantEventSnapshot | null {
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const id = stringOrNull(payload.call_id) ?? stringOrNull(payload.id) ?? buildCodexPayloadId('call', payload);
    const name = stringOrNull(payload.name) ?? stringOrNull(payload.tool_name) ?? String(payload.type);
    const input = parseMaybeJson(payload.arguments ?? payload.input ?? {});
    return buildCodexToolUseSnapshot(payload, id, name, input);
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const toolUseId = stringOrNull(payload.call_id) ?? stringOrNull(payload.id) ?? buildCodexPayloadId('result', payload);
    const content = Object.prototype.hasOwnProperty.call(payload, 'output') ? payload.output : payload.result;
    return buildCodexToolResultSnapshot(payload, toolUseId, typeof content === 'string' ? content : JSON.stringify(content ?? null), {
      isError: payload.is_error === true,
    });
  }
  if (payload.type === 'command_execution') {
    const toolUseId = stringOrNull(payload.id) ?? buildCodexPayloadId('command', payload);
    const input = compactObject({
      command: payload.command,
      status: payload.status,
    });
    if (eventType === 'item.started' || payload.status === 'in_progress') {
      return buildCodexToolUseSnapshot(payload, toolUseId, 'command_execution', input);
    }
    return buildCodexToolResultSnapshot(payload, toolUseId, stringifyToolPayload({
      command: payload.command,
      output: payload.aggregated_output,
      exitCode: payload.exit_code,
      status: payload.status,
    }), {
      isError: payload.status === 'failed' || (typeof payload.exit_code === 'number' && payload.exit_code !== 0),
    });
  }
  if (payload.type === 'file_change') {
    const toolUseId = stringOrNull(payload.id) ?? buildCodexPayloadId('file-change', payload);
    const input = compactObject({
      changes: payload.changes,
      status: payload.status,
    });
    if (eventType === 'item.started' || payload.status === 'in_progress') {
      return buildCodexToolUseSnapshot(payload, toolUseId, 'file_change', input);
    }
    return buildCodexToolResultSnapshot(payload, toolUseId, stringifyToolPayload(input), {
      isError: payload.status === 'failed',
    });
  }
  if (payload.type === 'patch_apply_end') {
    const toolUseId = stringOrNull(payload.call_id) ?? stringOrNull(payload.id) ?? buildCodexPayloadId('patch', payload);
    return buildCodexToolResultSnapshot(payload, toolUseId, stringifyToolPayload({
      stdout: payload.stdout,
      stderr: payload.stderr,
      success: payload.success,
      changes: payload.changes,
      status: payload.status,
    }), {
      isError: payload.success === false || payload.status === 'failed',
    });
  }
  return null;
}

function buildCodexToolUseSnapshot(
  payload: Record<string, unknown>,
  id: string,
  name: string,
  input: unknown,
): AssistantEventSnapshot {
  return {
    message: {
      id: buildCodexPayloadId('message', payload),
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id,
        name,
        input,
        caller: { type: 'codex', nativeType: payload.type },
      }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
}

function buildCodexToolResultSnapshot(
  payload: Record<string, unknown>,
  toolUseId: string,
  content: string,
  options: { readonly isError?: boolean } = {},
): AssistantEventSnapshot {
  return {
    message: {
      id: buildCodexPayloadId('message', payload),
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        ...(options.isError ? { is_error: true } : {}),
      }],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      diagnostics: null,
      context_management: null,
    },
  };
}

function compactObject(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function stringifyToolPayload(record: Record<string, unknown>): string {
  return JSON.stringify(compactObject(record));
}

function buildCodexPayloadId(prefix: string, payload: Record<string, unknown>): string {
  return `codex_${prefix}_${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nextCodexAssistantEventId(state: CodexStreamState, nativeId: unknown): string {
  if (typeof nativeId === 'string' && nativeId.trim()) {
    return nativeId.trim();
  }
  state.assistantEventSequence += 1;
  return `seq_${state.assistantEventSequence}`;
}

function buildCodexAgentMessageMirrorCandidate(phase: unknown, text: string): CodexAgentMessageMirrorCandidate {
  return {
    phase: codexPhaseKey(phase),
    text,
  };
}

function isCodexAgentMessageMirror(
  candidate: CodexAgentMessageMirrorCandidate | null,
  phase: unknown,
  text: string,
): boolean {
  return candidate !== null &&
    candidate.phase === codexPhaseKey(phase) &&
    candidate.text === text;
}

function codexPhaseKey(phase: unknown): string {
  return typeof phase === 'string' && phase.trim() ? phase.trim() : 'final_answer';
}

function appendAssistantText(
  state: Pick<CodexStreamState, 'assistantText' | 'lastAssistantText'>,
  callbacks: Pick<CodexStreamCallbacks, 'onAssistantText'>,
  text: string,
  options: { readonly publish?: boolean } = {},
): void {
  if (!text) {
    return;
  }
  if (options.publish === false) {
    return;
  }
  state.lastAssistantText = text;
  state.assistantText = state.assistantText ? `${state.assistantText}\n\n${text}` : text;
  callbacks.onAssistantText?.(state.assistantText);
}

function isFinalResponsePhase(phase: unknown): boolean {
  return phase === undefined || phase === 'final_answer';
}

function isVisibleAssistantMessagePhase(phase: unknown): phase is string {
  return phase === 'commentary' || phase === 'progress';
}
