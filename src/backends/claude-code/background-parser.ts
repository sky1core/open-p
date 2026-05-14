interface JsonObject {
  readonly [key: string]: unknown;
}

export class ClaudeCodeBackgroundRouter {
  private inTaskNotification = false;
  private readonly backgroundParentUuids = new Set<string>();
  private pendingTexts: string[] = [];

  consumeLine(line: string): readonly string[] {
    const event = parseJsonObject(line);
    if (!event) {
      return [];
    }

    if (event.type === 'user' && isTaskNotification(event)) {
      const flushed = this.flush();
      this.inTaskNotification = true;
      this.backgroundParentUuids.clear();
      const uuid = stringOrNull(event.uuid);
      if (uuid) {
        this.backgroundParentUuids.add(uuid);
      }
      return flushed;
    }

    if (!isKnownBackgroundEvent(this.backgroundParentUuids, event)) {
      if (this.inTaskNotification && !hasParentUuid(event) && isUnlinkedTaskEnd(event)) {
        this.inTaskNotification = false;
        this.backgroundParentUuids.clear();
        this.pendingTexts = [];
      }
      return [];
    }

    rememberBackgroundDescendant(this.backgroundParentUuids, event);

    if (event.type === 'assistant') {
      if (isSyntheticNoResponseAssistant(event)) {
        this.inTaskNotification = false;
        this.backgroundParentUuids.clear();
        this.pendingTexts = [];
        return [];
      }
      const message = asObject(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      for (const block of content) {
        const item = asObject(block);
        if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          this.pendingTexts.push(item.text);
        }
      }
      if (message?.stop_reason === 'end_turn') {
        this.inTaskNotification = false;
        this.backgroundParentUuids.clear();
        return this.flush();
      }
      return [];
    }

    if (event.type === 'result') {
      this.inTaskNotification = false;
      this.backgroundParentUuids.clear();
      return this.flush();
    }

    return [];
  }

  flush(): readonly string[] {
    if (this.pendingTexts.length === 0) {
      return [];
    }
    const text = joinTextBlocks(this.pendingTexts);
    this.pendingTexts = [];
    return [text];
  }
}

function joinTextBlocks(blocks: readonly string[]): string {
  return blocks.filter((block) => block.trim()).join('\n\n');
}

export function isClaudeCodeTaskNotificationLine(line: string): boolean {
  const event = parseJsonObject(line);
  return event?.type === 'user' && isTaskNotification(event);
}

function isTaskNotification(event: JsonObject): boolean {
  const origin = asObject(event.origin);
  return origin?.kind === 'task-notification';
}

function isKnownBackgroundEvent(backgroundParentUuids: Set<string>, event: JsonObject): boolean {
  const parentUuid = stringOrNull(event.parentUuid);
  return parentUuid !== null && backgroundParentUuids.has(parentUuid);
}

function hasParentUuid(event: JsonObject): boolean {
  return stringOrNull(event.parentUuid) !== null;
}

function rememberBackgroundDescendant(backgroundParentUuids: Set<string>, event: JsonObject): void {
  const uuid = stringOrNull(event.uuid);
  if (uuid) {
    backgroundParentUuids.add(uuid);
  }
}

function isUnlinkedTaskEnd(event: JsonObject): boolean {
  if (event.type === 'result') {
    return true;
  }
  if (event.type !== 'assistant') {
    return false;
  }
  const message = asObject(event.message);
  return message?.stop_reason === 'end_turn';
}

function isSyntheticNoResponseAssistant(event: JsonObject): boolean {
  const message = asObject(event.message);
  if (message?.model !== '<synthetic>') {
    return false;
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const textBlocks = content
    .map((block) => asObject(block))
    .filter((block): block is JsonObject => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => (block.text as string).trim())
    .filter((text) => text.length > 0);
  return textBlocks.length === 1 && textBlocks[0] === 'No response requested.';
}

function parseJsonObject(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }
  try {
    return asObject(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
