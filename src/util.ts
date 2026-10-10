export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
