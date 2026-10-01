import type { ComponentType, Rule, RuleAction } from '@vibe/shared';
import type { Entity } from './entity';
import { compileExpr, ExprError, type ExprScope } from './expr';
import type { Game } from './game';
import { emitSound } from './sound';
import { applyDamage } from './systems/interactions';

import { FIXED_DT, type GameEvent, type World } from './world';

interface FireContext {
  /** Entity behind the trigger: the one that entered the zone, or the event's "by"/"entity". */
  by?: Entity;
}

/**
 * Runs the scene rules (when -> if -> do) of one world, once per frame after the built-in
 * systems. A rule that throws (bad expression, missing target at runtime) is reported and
 * disabled until the scene reloads, like a failing script.
 */
export class RuleRunner {
  private readonly rules: Rule[];
  private readonly fired = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly exprWasTrue = new Map<string, boolean>();
  private readonly compiled = new Map<string, (scope: ExprScope) => unknown>();
  private readonly startFrame: number;
  private processed: number;
  private started = false;

  constructor(
    private readonly world: World,
    private readonly game: Game,
  ) {
    this.rules = world.scene.rules.filter((r) => r.enabled);
    this.startFrame = world.frame;
    this.processed = world.emitted;
  }

  /** `entered`: contacts that began this frame. */
  run(entered: [Entity, Entity][]) {
    if (!this.rules.length) return;
    const w = this.world;
    const fresh = this.newEvents();
    const firstRun = !this.started;
    this.started = true;
    const elapsed = w.frame - this.startFrame;

    for (const rule of this.rules) {
      if (w.status !== 'running') return;
      if (this.failed.has(rule.id) || (rule.once && this.fired.has(rule.id))) continue;
      const when = rule.when;
      try {
        if ('start' in when) {
          if (firstRun) this.fire(rule, {});
        } else if ('event' in when) {
          for (const ev of fresh) {
            if (ev.type !== when.event || !matches(ev, when.match)) continue;
            this.fire(rule, { by: this.entityOf(ev) });
            if (rule.once && this.fired.has(rule.id)) break;
          }
        } else if ('enter' in when) {
          for (const [a, b] of entered) {
            const other = a.id === when.enter ? b : b.id === when.enter ? a : null;
            if (!other || !other.hasTag(when.tag)) continue;
            this.fire(rule, { by: other });
            if (rule.once && this.fired.has(rule.id)) break;
          }
        } else if ('expr' in when) {
          const now = !!this.eval(when.expr);
          const before = this.exprWasTrue.get(rule.id) ?? false;
          this.exprWasTrue.set(rule.id, now);
          if (now && !before) this.fire(rule, {});
        } else if ('every' in when) {
          const period = Math.max(1, Math.round(when.every / 1000 / FIXED_DT));
          if (elapsed > 0 && elapsed % period === 0) this.fire(rule, {});
        }
      } catch (err) {
        this.failed.add(rule.id);
        const message = err instanceof Error ? err.message : String(err);
        w.console.error(`Rule "${rule.id}": ${message}\n(rule disabled until the scene reloads)`, 'rules');
        w.emit('rule_error', { rule: rule.id, message });
      }
    }
  }

  /** Events emitted since the previous run (including those emitted by rules then). */
  private newEvents(): GameEvent[] {
    const w = this.world;
    const count = Math.min(w.emitted - this.processed, w.events.length);
    this.processed = w.emitted;
    return count > 0 ? w.events.slice(-count) : [];
  }

  private entityOf(ev: GameEvent): Entity | undefined {
    for (const key of ['by', 'entity']) {
      const id = ev[key];
      if (typeof id === 'string') {
        const e = this.world.get(id);
        if (e) return e;
      }
    }
    return undefined;
  }

  private eval(src: string): unknown {
    let fn = this.compiled.get(src);
    if (!fn) {
      fn = compileExpr(src);
      this.compiled.set(src, fn);
    }
    try {
      return fn({ game: this.game });
    } catch (err) {
      if (err instanceof ExprError) throw new Error(`expression "${src}": ${err.message}`);
      throw err;
    }
  }

  private fire(rule: Rule, ctx: FireContext) {
    if (rule.if !== undefined && !this.eval(rule.if)) return;
    this.fired.add(rule.id);
    this.world.emit('rule', { rule: rule.id, ...(ctx.by && { by: ctx.by.id }) });
    for (const action of rule.do) {
      if (this.world.status !== 'running') return;
      this.act(rule, action, ctx);
    }
  }

  private target(target: string, ctx: FireContext): Entity {
    if (target === '$by') {
      if (!ctx.by) throw new Error('"$by" has no entity for this trigger');
      return ctx.by;
    }
    const e = this.world.get(target);
    if (!e) throw new Error(`entity "${target}" no longer exists`);
    return e;
  }

  private act(rule: Rule, a: RuleAction, ctx: FireContext) {
    const w = this.world;
    switch (a.action) {
      case 'setVar':
        w.vars[a.var] = a.value;
        return;
      case 'addVar':
        w.addVar(a.var, a.amount);
        return;
      case 'emit':
        w.emit(a.event, { ...a.data, rule: rule.id });
        return;
      case 'win':
      case 'lose':
        w.status = a.action === 'win' ? 'won' : 'lost';
        w.emit(a.action, { by: 'rule', rule: rule.id });
        w.console.log(`${a.action.toUpperCase()} by rule "${rule.id}"`, 'rules');
        return;
      case 'loadScene':
        w.pendingScene = a.scene;
        return;
      case 'destroy':
        w.destroy(this.target(a.target, ctx));
        return;
      case 'setEnabled':
        this.target(a.target, ctx).enabled = a.enabled;
        return;
      case 'setText': {
        const e = this.target(a.target, ctx);
        if (!e.components.Text) throw new Error(`entity "${e.id}" has no Text component`);
        e.components.Text.text = a.text;
        return;
      }
      case 'damage':
        applyDamage(w, this.target(a.target, ctx), a.amount, undefined, true);
        return;
      case 'heal': {
        const h = this.target(a.target, ctx).components.Health;
        if (h) h.current = Math.min(h.max, (h.current ?? h.max) + a.amount);
        return;
      }
      case 'move': {
        const e = this.target(a.target, ctx);
        if (a.x !== undefined) e.x = a.x;
        if (a.y !== undefined) e.y = a.y;
        return;
      }
      case 'modify': {
        const e = this.target(a.target, ctx);
        const data = e.components[a.component as ComponentType];
        if (!data) throw new Error(`entity "${e.id}" has no ${a.component} component`);
        Object.assign(data, structuredClone(a.set));
        return;
      }
      case 'log':
        w.console.log(a.message, `rule:${rule.id}`);
        return;
      case 'playSound':
        emitSound(w, a.asset, a.volume, `rule:${rule.id}`);
        return;
      case 'spawn': {
        const at = a.at ? this.target(a.at, ctx) : null;
        w.spawn(a.prefab, (at?.x ?? 0) + (a.x ?? 0), (at?.y ?? 0) + (a.y ?? 0), a.id);
        return;
      }
    }
  }
}

function matches(ev: GameEvent, match: Record<string, unknown> | undefined) {
  return !match || Object.entries(match).every(([k, v]) => ev[k] === v);
}
