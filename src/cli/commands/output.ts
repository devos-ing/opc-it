import { posix } from "node:path";
import { types } from "node:util";
import { redact } from "../../security/redact.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type OutputSchema =
  | { readonly kind: "boolean" }
  | { readonly kind: "number" }
  | { readonly kind: "null" }
  | { readonly kind: "string"; readonly accepts: (value: string) => boolean }
  | { readonly kind: "array"; readonly element: OutputSchema }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, OutputSchema>>;
      readonly required: ReadonlySet<string>;
    }
  | { readonly kind: "union"; readonly variants: readonly OutputSchema[] };

export interface OutputCodec<Result> {
  encode(value: Result): JsonValue;
}

export const booleanOutput: OutputSchema = Object.freeze({ kind: "boolean" });
export const numberOutput: OutputSchema = Object.freeze({ kind: "number" });
export const nullOutput: OutputSchema = Object.freeze({ kind: "null" });

export function stringOutput(accepts: (value: string) => boolean): OutputSchema {
  return Object.freeze({ kind: "string", accepts });
}

export function arrayOutput(element: OutputSchema): OutputSchema {
  return Object.freeze({ kind: "array", element });
}

export function objectOutput(
  fields: Readonly<Record<string, OutputSchema>>,
  required: readonly string[] = Object.keys(fields),
): OutputSchema {
  if (required.some((key) => !Object.hasOwn(fields, key))) {
    throw new Error("INVALID_OUTPUT_SCHEMA");
  }
  return Object.freeze({
    kind: "object",
    fields: Object.freeze({ ...fields }),
    required: new Set(required),
  });
}

export function unionOutput(...variants: readonly OutputSchema[]): OutputSchema {
  return Object.freeze({ kind: "union", variants: Object.freeze([...variants]) });
}

export function outputCodec<Result>(schema: OutputSchema): OutputCodec<Result> {
  return Object.freeze({ encode: (value: Result) => encode(value, schema, new Set(), 0) });
}

function encode(
  value: unknown,
  schema: OutputSchema,
  seen: Set<object>,
  depth: number,
): JsonValue {
  if (depth > 32) throw new Error("INVALID_COMMAND_OUTPUT");
  if (schema.kind === "union") {
    for (const variant of schema.variants) {
      try {
        return encode(value, variant, new Set(seen), depth);
      } catch {
        // Try the next closed alternative.
      }
    }
    throw new Error("INVALID_COMMAND_OUTPUT");
  }
  if (schema.kind === "null") {
    if (value !== null) throw new Error("INVALID_COMMAND_OUTPUT");
    return null;
  }
  if (schema.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error("INVALID_COMMAND_OUTPUT");
    return value;
  }
  if (schema.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("INVALID_COMMAND_OUTPUT");
    }
    return value;
  }
  if (schema.kind === "string") {
    if (typeof value !== "string" || value.length > 65_536) {
      throw new Error("INVALID_COMMAND_OUTPUT");
    }
    if (
      redact(value) !== value ||
      /(?:^|[^0-9])\d{6,12}:[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])/.test(value) ||
      /(?<!sha256:)\b[a-f0-9]{64}\b/.test(value)
    ) {
      throw new Error("SENSITIVE_OUTPUT_REJECTED");
    }
    if (!schema.accepts(value)) throw new Error("INVALID_COMMAND_OUTPUT");
    return value;
  }
  if (typeof value !== "object" || value === null || types.isProxy(value) || seen.has(value)) {
    throw new Error("INVALID_COMMAND_OUTPUT");
  }
  seen.add(value);
  if (schema.kind === "array") {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 10_000) {
      throw new Error("INVALID_COMMAND_OUTPUT");
    }
    if (Reflect.ownKeys(value).length !== value.length + 1) {
      throw new Error("INVALID_COMMAND_OUTPUT");
    }
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("INVALID_COMMAND_OUTPUT");
      }
      result.push(encode(descriptor.value, schema.element, seen, depth + 1));
    }
    seen.delete(value);
    return result;
  }
  if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("INVALID_COMMAND_OUTPUT");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1_000) throw new Error("INVALID_COMMAND_OUTPUT");
  if (schema.required.size > keys.length) throw new Error("INVALID_COMMAND_OUTPUT");
  const result: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(schema.fields, key)) {
      throw new Error("INVALID_COMMAND_OUTPUT");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("INVALID_COMMAND_OUTPUT");
    }
    const fieldSchema = schema.fields[key];
    if (fieldSchema === undefined) throw new Error("INVALID_COMMAND_OUTPUT");
    result[key] = encode(descriptor.value, fieldSchema, seen, depth + 1);
  }
  if ([...schema.required].some((key) => !Object.hasOwn(value, key))) {
    throw new Error("INVALID_COMMAND_OUTPUT");
  }
  seen.delete(value);
  return result;
}

export const digestOutput = stringOutput((value) => /^sha256:[a-f0-9]{64}$/.test(value));
export const pathOutput = stringOutput(
  (value) =>
    value.startsWith("/Users/") &&
    posix.isAbsolute(value) &&
    posix.normalize(value) === value &&
    !/[\0\r\n]/.test(value),
);
export const repositoryOutput = stringOutput((value) =>
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
);
export const instantOutput = stringOutput((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
});
