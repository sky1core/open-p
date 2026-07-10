export interface CodexNativeAssistantRecord {
  readonly source: 'event_msg' | 'response_item';
  readonly text: string;
  readonly rawText: string;
  readonly phase: unknown;
  readonly nativeId: unknown;
}

export interface CodexNativeAssistantClassification {
  readonly assistant: CodexNativeAssistantRecord | null;
  readonly mirrored: boolean;
}

interface CodexAgentMessageMirrorCandidate {
  readonly phase: string;
  readonly text: string;
}

export class CodexNativeAssistantClassifier {
  private mirrorCandidate: CodexAgentMessageMirrorCandidate | null = null;

  classify(event: Record<string, unknown>): CodexNativeAssistantClassification {
    const precedingCandidate = this.mirrorCandidate;
    this.mirrorCandidate = null;

    const payload = asObject(event.payload);
    if (event.type === 'event_msg' && payload?.type === 'agent_message') {
      const rawText = typeof payload.message === 'string' ? payload.message : null;
      if (!rawText?.trim()) {
        return { assistant: null, mirrored: false };
      }
      const assistant = buildAssistantRecord('event_msg', rawText, payload);
      this.mirrorCandidate = {
        phase: phaseKey(assistant.phase),
        text: assistant.rawText,
      };
      return { assistant, mirrored: false };
    }

    if (event.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant') {
      const output = extractOutputText(payload.content);
      if (!output) {
        return { assistant: null, mirrored: false };
      }
      const assistant: CodexNativeAssistantRecord = {
        source: 'response_item',
        text: output.text,
        rawText: output.rawText,
        phase: payload.phase,
        nativeId: payload.id,
      };
      return {
        assistant,
        mirrored: precedingCandidate !== null
          && precedingCandidate.phase === phaseKey(assistant.phase)
          && precedingCandidate.text === assistant.rawText,
      };
    }

    return { assistant: null, mirrored: false };
  }

  reset(): void {
    this.mirrorCandidate = null;
  }
}

function buildAssistantRecord(
  source: 'event_msg',
  rawText: string,
  payload: Record<string, unknown>,
): CodexNativeAssistantRecord {
  return {
    source,
    text: rawText.trim(),
    rawText,
    phase: payload.phase,
    nativeId: payload.id,
  };
}

function extractOutputText(content: unknown): { readonly text: string; readonly rawText: string } | null {
  if (!Array.isArray(content)) return null;

  const textParts: string[] = [];
  const rawTextParts: string[] = [];
  for (const block of content) {
    const record = asObject(block);
    if (record?.type === 'output_text' && typeof record.text === 'string' && record.text.trim()) {
      textParts.push(record.text.trim());
      rawTextParts.push(record.text);
    }
  }
  return textParts.length > 0
    ? { text: textParts.join('\n'), rawText: rawTextParts.join('\n') }
    : null;
}

function phaseKey(phase: unknown): string {
  return typeof phase === 'string' && phase.trim() ? phase.trim() : 'final_answer';
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
