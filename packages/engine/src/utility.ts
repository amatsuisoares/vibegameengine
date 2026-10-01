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
 *   weighted  random in proportion to the scores, from the seeded RNG
 *
 * Options whose `when` is false, that are cooling down (`cooldownMs` after they stop being the
 * choice; the current choice never cools down), or score <= 0 are left out; with none left,
 * the choice stays. A new choice emits "ai_choice" {entity, choice, from, score}, enters the
 * StateMachine state of the same name (or `state`) and calls onDecision(self, {choice, from, scores}).
 * Decisions happen every `intervalMs` (while `decideWhen` holds) or when a script calls
 * self.ai.decide(). An error emits "ai_error" and stops that entity's AI until the scene reloads.
 */

export type UtilityAIData = NonNullable<Components['UtilityAI']>;

/** Live AI state of an entity (kept on the Entity). */
export interface AiState {
  choice: string | null;
  /** Frame of the next automatic decision. */
  nextAt: number;
  /** Scores of the last decision (null = not available: when false or cooling down). */
  scores: Record<string, number | null>;
  /** Frame each option last stopped being the choice (its cooldown counts from there). */
  leftAt: Record<string, number>;
  failed?: boolean;
}

export interface DecisionHooks {
  decided(e: Entity, decision: { choice: string; from: string | null; scores: Record<string, number | null> }): void;
}

const framesOf = (ms: number) => Math.max(0, Math.round(ms / 1000 / FIXED_DT));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function aiOf(e: Entity): AiState | undefined {
  if (!e.components.UtilityAI) return undefined;
  return (e.ai ??= { choice: null, nextAt: 0, scores: {}, leftAt: {} });
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
    const candidates: { name: string; score: number; value: number }[] = [];
    for (const [name, o] of Object.entries(ai.options)) {
      const left = st.leftAt[name];
      const cooling = name !== st.choice && left !== undefined && o.cooldownMs > 0 && w.frame - left < framesOf(o.cooldownMs);
      if (cooling || (o.when !== undefined && !this.eval(o.when, e.id))) {
        scores[name] = null;
        continue;
      }
      const score = typeof o.score === 'number' ? o.score : Number(this.eval(o.score, e.id, true));
      if (!Number.isFinite(score)) throw new Error(`option "${name}": score is not a number (${String(score)})`);
      scores[name] = round3(score);
      if (score <= 0) continue;
      const noise = ai.noise > 0 ? w.rng.next() * ai.noise : 0;
      const inertia = ai.select === 'best' && name === st.choice ? ai.inertia : 0;
      candidates.push({ name, score, value: score + noise + inertia });
    }
    st.scores = scores;
    const pick = ai.select === 'weighted' ? this.weighted(candidates) : best(candidates);
    if (!pick) return st.choice;
    const from = st.choice;
    if (pick.name !== from) {
      st.choice = pick.name;
      if (from !== null) st.leftAt[from] = w.frame;
      w.emit('ai_choice', { entity: e.id, choice: pick.name, from, score: round3(pick.score) });
      const state = ai.options[pick.name].state ?? (e.components.StateMachine?.states[pick.name] ? pick.name : undefined);
      if (state) this.states.go(e, state);
      this.hooks.decided(e, { choice: pick.name, from, scores: { ...scores } });
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

  private eval(src: string, self: string, number = false): unknown {
    let fn = this.compiled.get(src);
    if (!fn) {
      fn = compileExpr(src);
      this.compiled.set(src, fn);
    }
    try {
      const v = fn({ game: this.game, self });
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
