import type { World } from './world';

/**
 * Expands placeholders in Text components:
 *   {coins}            -> game variable
 *   {player.health}    -> entity field (health, maxHealth, x, y)
 * Unknown placeholders are left untouched so mistakes are visible on screen.
 */
export function formatText(template: string, world: World): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (match, key: string) => {
    const dot = key.indexOf('.');
    if (dot < 0) {
      const v = world.vars[key];
      return v === undefined ? match : String(v);
    }
    const e = world.get(key.slice(0, dot));
    if (!e) return match;
    switch (key.slice(dot + 1)) {
      case 'health':
        return String(e.components.Health?.current ?? '');
      case 'maxHealth':
        return String(e.components.Health?.max ?? '');
      case 'x':
        return String(Math.round(e.x));
      case 'y':
        return String(Math.round(e.y));
      default:
        return match;
    }
  });
}
