/**
 * Stable JSON formatting for project files: containers that fit in `width` columns
 * stay on one line, larger ones are expanded one member per line. Output depends only
 * on the value, so rewriting an unchanged document is a no-op and diffs stay small.
 */
export function formatJson(value: unknown, width = 110): string {
  return `${format(value, 0, 0, width)}\n`;
}

function isContainer(v: unknown): v is object {
  return typeof v === 'object' && v !== null;
}

function inline(v: unknown): string {
  if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
  if (isContainer(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return entries.length ? `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v) ?? 'null';
}

/** `indent`: indentation of the current line; `col`: column where this value starts. */
function format(v: unknown, indent: number, col: number, width: number): string {
  const one = inline(v);
  // +1 for a trailing comma.
  if (!isContainer(v) || col + one.length + 1 <= width || one === '[]' || one === '{}') return one;
  const pad = ' '.repeat(indent + 2);
  const close = ' '.repeat(indent);
  if (Array.isArray(v)) {
    return `[\n${v.map((x) => pad + format(x, indent + 2, indent + 2, width)).join(',\n')}\n${close}]`;
  }
  const lines = Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => {
      const key = `${JSON.stringify(k)}: `;
      return pad + key + format(x, indent + 2, indent + 2 + key.length, width);
    });
  return `{\n${lines.join(',\n')}\n${close}}`;
}
