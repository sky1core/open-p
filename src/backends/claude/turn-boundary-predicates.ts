export interface ClaudeSessionLogEvent {
  readonly [key: string]: unknown;
}

export interface CallerUserTurnOptions {
  readonly isTaskNotification?: boolean;
}

export function isCallerUserTurn(
  event: ClaudeSessionLogEvent,
  localCommandTranscriptPromptIds: ReadonlySet<string>,
  options: CallerUserTurnOptions = {},
): boolean {
  if (event.type !== 'user') {
    return false;
  }
  if (options.isTaskNotification === true) {
    return false;
  }
  if (event.isMeta === true) {
    return false;
  }
  if (event.isCompactSummary === true) {
    return false;
  }
  if (userEventHasToolResult(event)) {
    return false;
  }
  if (isLocalCommandTranscriptEvent(event, localCommandTranscriptPromptIds)) {
    return false;
  }
  return true;
}

export function isLocalCommandTranscriptEvent(
  event: ClaudeSessionLogEvent,
  localCommandTranscriptPromptIds: ReadonlySet<string>,
): boolean {
  const texts = collectComparableUserText(event);
  if (texts.length !== 1) {
    return false;
  }
  if (texts[0] === '/exit') {
    return true;
  }
  const promptId = stringOrNull(event.promptId);
  // A real caller prompt always carries a promptId; a `! ...` shell transcript does not. The absent
  // promptId is what distinguishes a shell transcript from a caller prompt that merely starts with a
  // bash tag, so only treat bash-tagged text as a shell transcript when the promptId is absent.
  if (promptId === null && isShellCommandTranscriptText(texts[0]!)) {
    return true;
  }
  return promptId !== null &&
    localCommandTranscriptPromptIds.has(promptId) &&
    isLocalCommandTranscriptText(texts[0]!);
}

export function rememberLocalCommandTranscriptPromptId(
  promptIds: Set<string>,
  event: ClaudeSessionLogEvent,
): void {
  if (event.type !== 'user' || event.isMeta !== true) {
    return;
  }
  const promptId = stringOrNull(event.promptId);
  if (promptId === null || !isLocalCommandCaveatEvent(event)) {
    return;
  }
  promptIds.add(promptId);
}

export function collectUserText(event: ClaudeSessionLogEvent): string[] {
  const message = event.message;
  if (typeof message === 'string') {
    return [message];
  }
  const messageObject = asObject(message);
  if (!messageObject) {
    return [];
  }
  const content = messageObject.content;
  if (typeof content === 'string') {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    const item = asObject(block);
    if (!item) {
      continue;
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      texts.push(item.text);
      continue;
    }
    if (item.kind === 'text' && typeof item.data === 'string') {
      texts.push(item.data);
    }
  }
  return texts;
}

export function isStablePrefixOfLongerText(candidate: string, previous: string): boolean {
  const normalizedCandidate = normalizeForPrefixComparison(candidate);
  const normalizedPrevious = normalizeForPrefixComparison(previous);
  return normalizedCandidate.length > 0 &&
    normalizedPrevious.length > normalizedCandidate.length &&
    normalizedPrevious.startsWith(normalizedCandidate);
}

// A Claude Code local-command transcript (e.g. `/exit`, `/compact`) is a `type:user` event written when a
// local slash command runs; it is not a caller prompt. Bare `/exit` plus the tagged transcript forms
// (`<command-name>...`, `<local-command-stdout>...`, `<local-command-stderr>...`) all count.
const LOCAL_COMMAND_TRANSCRIPT_PREFIXES = ['<command-name>', '<local-command-stdout>', '<local-command-stderr>'];

export function isLocalCommandTranscriptText(text: string): boolean {
  return text === '/exit' || LOCAL_COMMAND_TRANSCRIPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// A `! ...` shell command run from the Claude Code prompt is written as `type:user` transcript events
// (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`) with NO `promptId`. They are CLI activity, not a
// caller prompt. Because they carry no promptId they cannot be matched through
// localCommandTranscriptPromptIds, so they are recognized by their structural prefix alone (like a bare
// `/exit`).
const SHELL_COMMAND_TRANSCRIPT_PREFIXES = ['<bash-input>', '<bash-stdout>', '<bash-stderr>'];

export function isShellCommandTranscriptText(text: string): boolean {
  return SHELL_COMMAND_TRANSCRIPT_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function isLocalCommandCaveatEvent(event: ClaudeSessionLogEvent): boolean {
  const texts = collectComparableUserText(event);
  return texts.length === 1 && texts[0]!.startsWith('<local-command-caveat>');
}

function collectComparableUserText(event: ClaudeSessionLogEvent): string[] {
  return collectUserText(event).map((text) => text.trim()).filter(Boolean);
}

export function userEventHasToolResult(event: ClaudeSessionLogEvent): boolean {
  const message = asObject(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.some((block) => asObject(block)?.type === 'tool_result');
}

function normalizeForPrefixComparison(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function asObject(value: unknown): ClaudeSessionLogEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as ClaudeSessionLogEvent;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
