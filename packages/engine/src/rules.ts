import type { Rule, RuleAction } from '@vibe/shared';
import { runAction } from './actions';
import type { Entity } from './entity';
import { compileExpr, ExprError, type ExprScope } from './expr';
import type { Game } from './game';
import { FIXED_DT, type GameEvent, type World } from './world';

interface FireContext {
  /** Entity behind the trigger: the one that entered the zone, or the event's "by"/"entity". */
  by?: Entity;
  /** The zone of an "enter" trigger, or the event's "entity". */
  entity?: Entity;
}

/**
 * Runs the scene rules (when -> if -> do) of one world, once per frame after the built-in
 * systems. A rule that throws (bad expression, missing target at runtime) is reported and
 * disabled until the scene reloads, like a failing script.
 */
/** What a rule runner remembers between frames (kept by a hot reload, so rules do not fire again). */
export interface RuleRunnerState {
  started: boolean;
  startFrame: number;
  fired: string[];
  exprWasTrue: Record<string, boolean>;
}

export class RuleRunner {
  private readonly rules: Rule[];
  private readonly fired = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly exprWasTrue = new Map<string, boolean>();
  private readonly compiled = new Map<string, (scope: ExprScope) => unknown>();
  private startFrame: number;
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

  saveState(): RuleRunnerState {
    return { started: this.started, startFrame: this.startFrame, fired: [...this.fired], exprWasTrue: Object.fromEntries(this.exprWasTrue) };
  }

  /** Continues from a saved state (rules that no longer exist are ignored). */
  loadState(s: RuleRunnerState) {
    const ids = new Set(this.rules.map((r) => r.id));
    this.started = s.started;
    this.startFrame = s.startFrame;
    for (const id of s.fired) if (ids.has(id)) this.fired.add(id);
    for (const [id, v] of Object.entries(s.exprWasTrue)) if (ids.has(id)) this.exprWasTrue.set(id, v);
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
            this.fire(rule, { by: this.entityOf(ev), entity: typeof ev.entity === 'string' ? this.world.get(ev.entity) : undefined });
            if (rule.once && this.fired.has(rule.id)) break;
          }
        } else if ('enter' in when) {
          for (const [a, b] of entered) {
            const [zone, other] = a.id === when.enter ? [a, b] : b.id === when.enter ? [b, a] : [null, null];
            if (!zone || !other.hasTag(when.tag)) continue;
            this.fire(rule, { by: other, entity: zone });
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
    if (target === '$entity') {
      if (!ctx.entity) throw new Error('"$entity" has no entity for this trigger');
      return ctx.entity;
    }
    const e = this.world.get(target);
    if (!e) throw new Error(`entity "${target}" no longer exists`);
    return e;
  }

  private act(rule: Rule, a: RuleAction, ctx: FireContext) {
    runAction(this.world, a, (ref) => this.target(ref, ctx), {
      kind: 'rule',
      data: { rule: rule.id },
      label: `rule "${rule.id}"`,
      source: `rule:${rule.id}`,
    });
  }
}

export function matches(ev: GameEvent, match: Record<string, unknown> | undefined) {
  return !match || Object.entries(match).every(([k, v]) => ev[k] === v);
}
