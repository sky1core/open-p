import { Ajv, type ValidateFunction } from 'ajv';
import { EXIT_CODES, OpenPError } from './errors.js';

const ajv = new Ajv({ allErrors: true, strict: false });

export function parseJsonSchemaText(value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new OpenPError('--json-schema requires a JSON object', EXIT_CODES.usage);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OpenPError('--json-schema requires a JSON object', EXIT_CODES.usage);
  }

  compileSchema(parsed);
  return parsed;
}

export function validateStructuredOutput(value: unknown, schema: unknown, turnId: string): void {
  if (!schema) {
    return;
  }

  const validate = compileSchema(schema);
  if (validate(value)) {
    return;
  }

  throw new OpenPError(
    `structured output for turn ${turnId} did not match JSON schema: ${ajv.errorsText(validate.errors)}`,
    EXIT_CODES.protocolViolation,
  );
}

function compileSchema(schema: unknown): ValidateFunction {
  try {
    return ajv.compile(schema as Parameters<Ajv['compile']>[0]);
  } catch (error) {
    const message = error instanceof Error && error.message ? `: ${error.message}` : '';
    throw new OpenPError(`invalid --json-schema${message}`, EXIT_CODES.usage);
  }
}
