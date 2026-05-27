const ASSISTANT_MARKER = '⏺';
const USER_MARKER = '❯';

export function extractClaudeCodeScreenAssistantText(screenText: string): string | null {
  const lines = screenText.replace(/\r\n/g, '\n').split('\n');
  const markerIndex = findLastAssistantTextMarker(lines);
  if (markerIndex === -1) {
    return null;
  }

  const textLines: string[] = [];
  for (let index = markerIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (index !== markerIndex && isClaudeCodeScreenBoundary(line)) {
      break;
    }
    const textLine = normalizeAssistantScreenLine(line, index === markerIndex);
    if (textLine === null) {
      continue;
    }
    textLines.push(textLine);
  }

  const text = trimEmptyEdges(textLines).join('\n').trimEnd();
  return text.trim().length > 0 ? text : null;
}

function findLastAssistantTextMarker(lines: readonly string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (isNonEmptyUserPromptLine(line)) {
      return -1;
    }
    if (line.trimStart().startsWith(ASSISTANT_MARKER)) {
      return isAssistantTextStart(line) ? index : -1;
    }
  }
  return -1;
}

function isNonEmptyUserPromptLine(line: string): boolean {
  if (!line.startsWith(USER_MARKER)) {
    return false;
  }
  return line.slice(USER_MARKER.length).trim().length > 0;
}

function isAssistantTextStart(line: string): boolean {
  const markerIndex = line.indexOf(ASSISTANT_MARKER);
  if (markerIndex === -1) {
    return false;
  }
  const text = line.slice(markerIndex + ASSISTANT_MARKER.length).trimStart();
  if (!text) {
    return false;
  }
  return !isClaudeCodeToolOrChromeLine(text);
}

function normalizeAssistantScreenLine(line: string, firstLine: boolean): string | null {
  if (firstLine) {
    const markerIndex = line.indexOf(ASSISTANT_MARKER);
    return markerIndex === -1 ? null : line.slice(markerIndex + ASSISTANT_MARKER.length).trimStart();
  }
  if (line.startsWith('  ')) {
    return line.slice(2);
  }
  return line.trimEnd();
}

function isClaudeCodeScreenBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (line.startsWith(USER_MARKER) || trimmed.startsWith(ASSISTANT_MARKER)) {
    return true;
  }
  if (trimmed.startsWith('✻') || trimmed.startsWith('⏵')) {
    return true;
  }
  if (/^[─━═╍╎╏\s]+$/u.test(line)) {
    return true;
  }
  if (trimmed.includes('bypass permissions') || /\b\d+\s+tokens\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

function isClaudeCodeToolOrChromeLine(text: string): boolean {
  if (/^(Read|Edit|MultiEdit|Write|Bash|Grep|Glob|LS|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit|ExitPlanMode|Search|Fetch|List)\(/u.test(text)) {
    return true;
  }
  if (/^(Update Todos|Read|Edit|MultiEdit|Write|Bash|Grep|Glob|LS|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit|ExitPlanMode|Search|Fetch|List|Running|Interrupted|Error|Permission|User approved|User rejected)\b/u.test(text)) {
    return true;
  }
  if (/^(⎿|⧉|☒|☐|☑)\s/u.test(text)) {
    return true;
  }
  return false;
}

function trimEmptyEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) {
    start += 1;
  }
  while (end > start && !lines[end - 1]?.trim()) {
    end -= 1;
  }
  return lines.slice(start, end);
}
