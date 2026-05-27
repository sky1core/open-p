#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const behavior = process.env.OPENP_FAKE_KIRO_BEHAVIOR ?? 'success';
const argsLog = process.env.OPENP_FAKE_KIRO_ARGS_LOG;
const rpcLog = process.env.OPENP_FAKE_KIRO_RPC_LOG;
const signalLog = process.env.OPENP_FAKE_KIRO_SIGNAL_LOG;
const writeSessionLog = process.env.OPENP_FAKE_KIRO_WRITE_SESSION_LOG === '1';
let pendingPromptId = null;
let delayedEffortTexts = [];

if (argsLog) {
  appendFileSync(argsLog, `${process.argv.slice(2).join('\t')}\n`);
}

if (behavior === 'error') {
  console.error('fake kiro failed');
  process.exit(1);
}

process.on('SIGINT', () => {
  logSignal('SIGINT');
  if (behavior === 'error-after-interrupt' && pendingPromptId !== null) {
    send({
      jsonrpc: '2.0',
      id: pendingPromptId,
      error: { code: -32000, message: 'interrupted by fake backend' },
    });
    return;
  }
  if (behavior !== 'ignore-interrupt') {
    process.exit(130);
  }
});

process.on('SIGTERM', () => {
  logSignal('SIGTERM');
  if (behavior !== 'ignore-interrupt') {
    process.exit(143);
  }
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) {
    continue;
  }
  const message = JSON.parse(line);
  if (rpcLog && message.method) {
    appendFileSync(rpcLog, `${message.method}\t${JSON.stringify(message.params ?? {})}\n`);
  }

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
        },
        authMethods: [],
        agentInfo: { name: 'Fake Kiro', version: '0.0.0' },
      },
    });
    continue;
  }

  if (message.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      method: '_kiro.dev/metadata',
      params: {
        sessionId: SESSION_ID,
        contextUsagePercentage: 1.5,
      },
    });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: behavior === 'no-session' ? {} : { sessionId: SESSION_ID },
    });
    continue;
  }

  if (message.method === 'session/load') {
    const sessionId = message.params.sessionId;
    const loadedSessionId = behavior === 'load-mismatch'
      ? '44444444-4444-4444-8444-444444444444'
      : sessionId;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'previous stale answer' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { sessionId: loadedSessionId },
    });
    continue;
  }

  if (message.method === 'session/prompt') {
    const sessionId = message.params.sessionId;
    const promptText = message.params.prompt?.[0]?.text ?? '';
    appendSessionLog(sessionId, {
      version: 'v1',
      kind: 'Prompt',
      data: {
        message_id: `prompt-${Date.now()}`,
        content: [{ kind: 'text', data: promptText }],
        meta: { timestamp: Math.floor(Date.now() / 1000) },
      },
    });
    if (promptText.startsWith('/effort ')) {
      const effort = promptText.slice('/effort '.length).trim();
      const text = behavior === 'effort-unavailable'
        ? 'Effort configuration is currently not available on auto. Select a /model that supports effort to configure.'
        : behavior === 'effort-does-not-support'
          ? `The current model does not support effort ${effort}.`
        : behavior === 'effort-unsupported'
          ? `Unsupported effort: ${effort}.`
        : `Effort set to ${effort}.`;
      if (behavior !== 'effort-late-output') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text },
            },
          },
        });
      } else {
        const delayedText = `Effort setup settled for ${effort}.`;
        delayedEffortTexts = [text, delayedText];
        setTimeout(() => appendSessionLog(sessionId, {
          version: 'v1',
          kind: 'AssistantMessage',
          data: {
            message_id: `assistant-${Date.now()}-effort-tail`,
            content: [{ kind: 'text', data: delayedText }],
          },
        }), 150);
      }
      if (behavior !== 'effort-log-missing') {
        appendSessionLog(sessionId, {
          version: 'v1',
          kind: 'AssistantMessage',
          data: {
            message_id: `assistant-${Date.now()}`,
            content: [{ kind: 'text', data: text }],
          },
        });
      }
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { stopReason: 'end_turn' },
      });
      continue;
    }
    if (behavior === 'error-after-interrupt') {
      pendingPromptId = message.id;
      setInterval(() => undefined, 1000);
      continue;
    }
    if (behavior === 'slow' || behavior === 'ignore-interrupt') {
      setInterval(() => undefined, 1000);
      continue;
    }
    if (behavior === 'permission') {
      send({
        jsonrpc: '2.0',
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'tooluse_fake',
            title: 'Creating protected file',
          },
          options: [
            { optionId: 'allow_once', name: 'Yes', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'No', kind: 'reject_once' },
          ],
        },
      });
      setInterval(() => undefined, 1000);
      continue;
    }
    if (behavior === 'effort-late-output' && delayedEffortTexts.length > 0) {
      for (const delayedEffortText of delayedEffortTexts) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: delayedEffortText },
            },
          },
        });
        appendSessionLog(sessionId, {
          version: 'v1',
          kind: 'AssistantMessage',
          data: {
            message_id: `assistant-${Date.now()}-late-effort`,
            content: [{ kind: 'text', data: delayedEffortText }],
          },
        });
      }
      delayedEffortTexts = [];
    }
    if (behavior === 'tool-only') {
      appendSessionLog(sessionId, {
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          message_id: `assistant-${Date.now()}-tool`,
          content: [{
            kind: 'toolUse',
            data: {
              toolUseId: 'tooluse_only',
              name: 'readFile',
              input: { path: 'README.md' },
            },
          }],
        },
      });
      appendSessionLog(sessionId, {
        version: 'v1',
        kind: 'ToolResults',
        data: {
          content: [{
            kind: 'toolResult',
            data: {
              toolUseId: 'tooluse_only',
              content: [{ kind: 'text', data: 'file text' }],
            },
          }],
        },
      });
      send({
        jsonrpc: '2.0',
        method: '_kiro.dev/metadata',
        params: {
          sessionId,
          contextUsagePercentage: 2.5,
          meteringUsage: [{ value: 0.1, unit: 'credit', unitPlural: 'credits' }],
          turnDurationMs: 123,
        },
      });
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { stopReason: 'end_turn' },
      });
      continue;
    }
    if (behavior !== 'empty') {
      const assistantChunks = behavior === 'multi-chunk'
        ? ['alpha ', 'beta ', 'gamma']
        : behavior === 'log-final-diff'
          ? ['draft ']
        : behavior === 'effort-answer-same'
          ? ['Effort set to high.']
        : [message.params.prompt[0].text === 'follow up' ? 'fresh ' : 'partial ', 'answer'];
      const finalLogText = behavior === 'log-final-diff'
        ? 'authoritative final'
        : behavior === 'multi-log-delayed'
          ? 'A'
        : assistantChunks.join('');
      send({
        jsonrpc: '2.0',
        method: '_kiro.dev/session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_chunk',
            toolCallId: 'tooluse_fake',
            title: 'write',
            kind: 'edit',
          },
        },
      });
      for (const chunk of assistantChunks) {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk },
            },
          },
        });
      }
      const assistantLogEvent = {
        version: 'v1',
        kind: 'AssistantMessage',
        data: {
          message_id: `assistant-${Date.now()}`,
          content: [{ kind: 'text', data: finalLogText }],
        },
      };
      if (behavior === 'delayed-log') {
        setTimeout(() => appendSessionLog(sessionId, assistantLogEvent), 150);
      } else if (behavior === 'multi-log-delayed') {
        appendSessionLog(sessionId, assistantLogEvent);
        setTimeout(() => appendSessionLog(sessionId, {
          version: 'v1',
          kind: 'AssistantMessage',
          data: {
            message_id: `assistant-${Date.now()}-second`,
            content: [{ kind: 'text', data: 'B' }],
          },
        }), 300);
      } else {
        appendSessionLog(sessionId, assistantLogEvent);
      }
    }
    send({
      jsonrpc: '2.0',
      method: '_kiro.dev/metadata',
      params: {
        sessionId,
        contextUsagePercentage: 2.5,
        meteringUsage: [{ value: 0.1, unit: 'credit', unitPlural: 'credits' }],
        turnDurationMs: 123,
      },
    });
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { stopReason: 'end_turn' },
    });
    if (behavior === 'post-response-update') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' stale post-response text' },
          },
        },
      });
    }
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function logSignal(signal) {
  if (signalLog) {
    appendFileSync(signalLog, `${signal}\n`);
  }
}

function appendSessionLog(sessionId, event) {
  if (!writeSessionLog || !process.env.HOME) {
    return;
  }
  const sessionDir = join(process.env.HOME, '.kiro', 'sessions', 'cli');
  mkdirSync(sessionDir, { recursive: true });
  appendFileSync(join(sessionDir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}
