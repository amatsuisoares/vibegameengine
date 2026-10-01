import type { ComponentType, RuleAction } from '@vibe/shared';
import type { Entity } from './entity';
import { emitSound } from './sound';
import { applyDamage } from './systems/interactions';
import type { World } from './world';

/** Who runs an action: a scene rule or a state of a StateMachine. */
export interface ActionOrigin {
  kind: 'rule' | 'state';
  /** Added to events the action emits, e.g. { rule: "open" } or { entity: "boss", state: "angry" }. */
  data: Record<string, string>;
  /** For log lines, e.g. `rule "open"`. */
  label: string;
  /** Console source, e.g. "rule:open". */
  source: string;
}

/**
 * Runs one data-driven action (the "do" list of rules, enter/exit of states). `target` resolves
 * an entity reference ("$by", an id...) and throws when it cannot.
 */
export function runAction(w: World, a: RuleAction, target: (ref: string) => Entity, origin: ActionOrigin) {
  switch (a.action) {
    case 'setVar':
      w.vars[a.var] = a.value;
      return;
    case 'addVar':
      w.addVar(a.var, a.amount);
      return;
    case 'emit':
      w.emit(a.event, { ...a.data, ...origin.data });
      return;
    case 'win':
    case 'lose':
      w.status = a.action === 'win' ? 'won' : 'lost';
      w.emit(a.action, { by: origin.kind, ...origin.data });
      w.console.log(`${a.action.toUpperCase()} by ${origin.label}`, `${origin.kind}s`);
      return;
    case 'loadScene':
      w.pendingScene = a.scene;
      return;
    case 'destroy':
      w.destroy(target(a.target));
      return;
    case 'setEnabled':
      target(a.target).enabled = a.enabled;
      return;
    case 'setText': {
      const e = target(a.target);
      if (!e.components.Text) throw new Error(`entity "${e.id}" has no Text component`);
      e.components.Text.text = a.text;
      return;
    }
    case 'damage':
      applyDamage(w, target(a.target), a.amount, undefined, true);
      return;
    case 'heal': {
      const h = target(a.target).components.Health;
      if (h) h.current = Math.min(h.max, (h.current ?? h.max) + a.amount);
      return;
    }
    case 'move': {
      const e = target(a.target);
      if (a.x !== undefined) e.x = a.x;
      if (a.y !== undefined) e.y = a.y;
      return;
    }
    case 'modify': {
      const e = target(a.target);
      const data = e.components[a.component as ComponentType];
      if (!data) throw new Error(`entity "${e.id}" has no ${a.component} component`);
      Object.assign(data, structuredClone(a.set));
      return;
    }
    case 'log':
      w.console.log(a.message, origin.source);
      return;
    case 'playSound':
      emitSound(w, a.asset, a.volume, origin.source);
      return;
    case 'after': {
      const owner = origin.kind === 'state' ? w.get(origin.data.entity) : undefined;
      const id = w.timers.schedule({
        id: a.id,
        ms: a.ms,
        owner,
        run: () => {
          for (const sub of a.do) {
            if (w.status !== 'running') return;
            runAction(w, sub, target, origin);
          }
        },
        onError: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          w.console.error(`Timer "${id}" of ${origin.label}: ${message}`, origin.source);
          w.emit('timer_error', { timer: id, message, ...origin.data });
        },
      });
      return;
    }
    case 'cancelTimer':
      w.timers.cancel(a.id, origin.kind === 'state' ? w.get(origin.data.entity) : undefined);
      return;
    case 'spawn': {
      const at = a.at ? target(a.at) : null;
      w.spawn(a.prefab, (at?.x ?? 0) + (a.x ?? 0), (at?.y ?? 0) + (a.y ?? 0), a.id);
      return;
    }
  }
}
