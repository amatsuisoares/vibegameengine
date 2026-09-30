export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * JSON Merge Patch (RFC 7386): objects merge recursively, `null` deletes a key,
 * anything else (including arrays) replaces the target value. Inputs are not mutated.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return structuredClone(patch);
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}
