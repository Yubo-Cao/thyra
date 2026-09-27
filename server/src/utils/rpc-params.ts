/**
 * Typed reads of RPC params. A wrong type is rejected with a clear RPC error
 * instead of being coerced (an object must never become "[object Object]").
 * Missing (undefined or null) values are distinct from wrong types so callers
 * keep their own defaults and "required" messages.
 */
export class RpcParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcParamError";
  }
}

function field(params: unknown, name: string): unknown {
  if (params === undefined || params === null) return undefined;
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new RpcParamError("invalid params: expected an object");
  }
  return (params as Record<string, unknown>)[name];
}

export function optionalString(
  params: unknown,
  name: string,
): string | undefined {
  const value = field(params, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new RpcParamError(`invalid params: ${name} must be a string`);
  }
  return value;
}

export function requireString(params: unknown, name: string): string {
  const value = optionalString(params, name);
  if (value === undefined) {
    throw new RpcParamError(`invalid params: ${name} is required`);
  }
  return value;
}

export function optionalNumber(
  params: unknown,
  name: string,
): number | undefined {
  const value = field(params, name);
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RpcParamError(`invalid params: ${name} must be a finite number`);
  }
  return value;
}

export function requireNumber(params: unknown, name: string): number {
  const value = optionalNumber(params, name);
  if (value === undefined) {
    throw new RpcParamError(`invalid params: ${name} is required`);
  }
  return value;
}
