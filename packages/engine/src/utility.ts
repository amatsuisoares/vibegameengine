import type { Components } from '@vibe/shared';
import type { Entity } from './entity';
import { compileExpr, ExprError, type ExprScope } from './expr';
import type { StateMachineRunner } from './fsm';
import type { Game } from './game';
import { FIXED_DT, type World } from './world';

/**
 * Utility AI: an entity with a `UtilityAI` component picks what to do by scoring its options with
 * expressions over the game state — needs and personality (self.props), distance, time (clock),
 * variables, its state, cooldowns. The engine imposes no factors: the game writes the scores.
 *
 *   best      highest score (+ `inertia` for the current choice, so close scores do not flip-flop)
 *   weighted  random in proportion to the scores (to score^sharpness), from the seeded RNG
 *
 * Options whose `when` is false, that are cooling down (`cooldownMs` after they stop being the
 * choice; the current choice never cools down), or score <= 0 are left out; with none left,
 * the choice stays. A new choice emits "ai_choice" {entity, choice, from, score}, enters the
 * StateMachine state of the same name (or `state`) and calls onDecision(self, {choice, from, scores, target}).
 * An option with `targets` is scored once per candidate entity (`target` in its expressions); the
 * best candidate is the option's score. When the option is chosen its target (self.ai.target, "smart
 * objects") is that best candidate with select "best"; with "weighted" it is drawn like the options
 * (chance ∝ score^sharpness), so the favorite wins most of the time but not always.
 * Decisions happen every `intervalMs` (while `decideWhen` holds) or when a script calls
 * self.ai.decide(). An error emits "ai_error" and stops that entity's AI until the scene reloads.
 */

export type UtilityAIData = NonNullable<Components['UtilityAI']>;

/** Live AI state of an entity (kept on the Entity). */
export interface AiState {
  choice: string | null;
  /** Entity the current choice is about (options with targets), or null. */
  target: string | null;
  /** Best candidate of each targeted option in the last decision. */
  targets: Record<string, string | null>;
  /** Frame of the next automatic decision. */
  nextAt: number;
  /** Scores of the last decision (null = not available: when false or cooling down). */
  scores: Record<string, number | null>;
  /** Frame each option last stopped being the choice (its cooldown counts from there). */
  leftAt: Record<string, number>;
  failed?: boolean;
}

export interface DecisionHooks {
  decided(e: Entity, decision: { choice: string; from: string | null; scores: Record<string, number | null>; target: string | null }): void;
}

const framesOf = (ms: number) => Math.max(0, Math.round(ms / 1000 / FIXED_DT));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function aiOf(e: Entity): AiState | undefined {
  if (!e.components.UtilityAI) return undefined;
  return (e.ai ??= { choice: null, target: null, targets: {}, nextAt: 0, scores: {}, leftAt: {} });
}

/** Runs the Utility AIs of one world (created per scene load). */
export class UtilityRunner {
  private readonly compiled = new Map<string, (scope: ExprScope) => unknown>();

  constructor(
    private readonly world: World,
    private readonly game: Game,
    private readonly hooks: DecisionHooks,
    private readonly states: StateMachineRunner,
  ) {}

  /** Once per frame (after the rules, before the state machines): automatic decisions that are due. */
  run() {
    const w = this.world;
    for (const e of [...w.entities]) {
      if (w.status !== 'running') return;
      const ai = e.components.UtilityAI;
      const st = aiOf(e);
      if (!ai || !st || !e.active || st.failed || ai.intervalMs === 0 || w.frame < st.nextAt) continue;
      try {
        if (ai.decideWhen !== undefined && !this.eval(ai.decideWhen, e.id)) continue;
        st.nextAt = w.frame + Math.max(1, framesOf(ai.intervalMs));
        this.decide(e);
      } catch (err) {
        this.fail(e, st, err);
      }
    }
  }

  /** Scores the options and applies the choice; returns it (null when nothing is available). */
  decide(e: Entity): string | null {
    const ai = e.components.UtilityAI;
    const st = aiOf(e);
    if (!ai || !st) throw new Error(`entity "${e.id}" has no UtilityAI`);
    const w = this.world;
    const scores: Record<string, number | null> = {};
    const targets: Record<string, string | null> = {};
    const candidates: { name: string; score: number; value: number; target: string | null }[] = [];
    const pools: Record<string, { id: string; value: number }[]> = {};
    for (const [name, o] of Object.entries(ai.options)) {
      const left = st.leftAt[name];
      const cooling = name !== st.choice && left !== undefined && o.cooldownMs > 0 && w.frame - left < framesOf(o.cooldownMs);
      if (cooling || (o.when !== undefined && !o.targets && !this.eval(o.when, e.id))) {
        scores[name] = null;
        continue;
      }
      let score: number;
      let target: string | null = null;
      if (o.targets) {
        // Smart objects: the best candidate (ties: scene order) gives the option its score.
        let top: { id: string; score: number } | null = null;
        const pool: { id: string; value: number }[] = (pools[name] = []);
        for (const c of w.withTag(o.targets.tag)) {
          if (c === e || !c.active) continue;
          if (o.targets.when !== undefined && !this.eval(o.targets.when, e.id, false, c.id)) continue;
          if (o.when !== undefined && !this.eval(o.when, e.id, false, c.id)) continue;
          const s = this.scoreOf(name, o.score, e.id, c.id);
          if (!top || s > top.score) top = { id: c.id, score: s };
          if (s > 0) pool.push({ id: c.id, value: Math.pow(s, ai.sharpness) });
        }
        targets[name] = top?.id ?? null;
        if (!top) {
          scores[name] = null;
          continue;
        }
        score = top.score;
        target = top.id;
      } else score = this.scoreOf(name, o.score, e.id);
      scores[name] = round3(score);
      if (score <= 0) continue;
      const noise = ai.noise > 0 ? w.rng.next() * ai.noise : 0;
      const inertia = ai.select === 'best' && name === st.choice && target === st.target ? ai.inertia : 0;
      const shaped = ai.select === 'weighted' && ai.sharpness !== 1 ? Math.pow(score, ai.sharpness) : score;
      candidates.push({ name, score, value: shaped + noise + inertia, target });
    }
    st.scores = scores;
    st.targets = targets;
    const pick = ai.select === 'weighted' ? this.weighted(candidates) : best(candidates);
    if (!pick) return st.choice;
    const pool = pools[pick.name];
    if (ai.select === 'weighted' && pool && pool.length > 1) pick.target = this.weighted(pool)!.id;
    const from = st.choice;
    if (pick.name !== from || pick.target !== st.target) {
      st.choice = pick.name;
      st.target = pick.target;
      if (from !== null && from !== pick.name) st.leftAt[from] = w.frame;
      w.emit('ai_choice', { entity: e.id, choice: pick.name, from, score: round3(pick.score), ...(pick.target !== null && { target: pick.target }) });
      const state = ai.options[pick.name].state ?? (e.components.StateMachine?.states[pick.name] ? pick.name : undefined);
      if (state) this.states.go(e, state);
      this.hooks.decided(e, { choice: pick.name, from, scores: { ...scores }, target: pick.target });
    }
    return st.choice;
  }

  private weighted<T extends { value: number }>(list: T[]): T | null {
    const total = list.reduce((s, c) => s + c.value, 0);
    if (!list.length || total <= 0) return null;
    let r = this.world.rng.next() * total;
    for (const c of list) {
      r -= c.value;
      if (r < 0) return c;
    }
    return list[list.length - 1];
  }

  private scoreOf(name: string, src: number | string, self: string, target?: string): number {
    const score = typeof src === 'number' ? src : Number(this.eval(src, self, true, target));
    if (!Number.isFinite(score)) throw new Error(`option "${name}": score is not a number (${String(score)})${target ? ` (target "${target}")` : ''}`);
    return score;
  }

  private eval(src: string, self: string, number = false, target?: string): unknown {
    let fn = this.compiled.get(src);
    if (!fn) {
      fn = compileExpr(src);
      this.compiled.set(src, fn);
    }
    try {
      const v = fn({ game: this.game, self, ...(target !== undefined && { target }) });
      return number ? (typeof v === 'boolean' ? Number(v) : v) : !!v;
    } catch (err) {
      if (err instanceof ExprError) throw new Error(`expression "${src}": ${err.message}`);
      throw err;
    }
  }

  private fail(e: Entity, st: AiState, err: unknown) {
    st.failed = true;
    const message = err instanceof Error ? err.message : String(err);
    this.world.console.error(`UtilityAI of "${e.id}": ${message}\n(AI disabled until the scene reloads)`, 'ai');
    this.world.emit('ai_error', { entity: e.id, message });
  }
}

/** Highest value; ties keep the option order. */
function best<T extends { value: number }>(list: T[]): T | null {
  let top: T | null = null;
  for (const c of list) if (!top || c.value > top.value) top = c;
  return top;
}
