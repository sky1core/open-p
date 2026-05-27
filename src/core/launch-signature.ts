import type { LaunchSignature } from './worker-types.js';

export interface BuildLaunchSignatureInput {
  readonly backendId: string;
  readonly bin: string;
  readonly binArgs: readonly string[];
  readonly model?: string | null;
  readonly reasoningEffort?: string | null;
  readonly executionMode?: string | null;
  readonly tools?: string | null;
  readonly jsonSchema?: string | null;
  readonly env?: Readonly<Record<string, string>>;
  readonly local?: boolean;
}

export function buildLaunchSignature(input: BuildLaunchSignatureInput): LaunchSignature {
  return {
    backendId: input.backendId,
    bin: input.bin,
    binArgs: [...input.binArgs],
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    executionMode: input.executionMode ?? null,
    tools: input.tools ?? null,
    jsonSchema: input.jsonSchema ?? null,
    env: sortEnv(input.env ?? {}),
    local: input.local ?? false,
  };
}

export function launchSignaturesEqual(left: LaunchSignature, right: LaunchSignature): boolean {
  return stableLaunchSignatureKey(left) === stableLaunchSignatureKey(right);
}

export function stableLaunchSignatureKey(signature: LaunchSignature): string {
  return JSON.stringify({
    backendId: signature.backendId,
    bin: signature.bin,
    binArgs: signature.binArgs,
    model: signature.model,
    reasoningEffort: signature.reasoningEffort,
    executionMode: signature.executionMode,
    tools: signature.tools,
    jsonSchema: signature.jsonSchema,
    env: sortEnv(signature.env),
    local: signature.local,
  });
}

function sortEnv(env: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(env).sort(([left], [right]) => left.localeCompare(right)),
  );
}
