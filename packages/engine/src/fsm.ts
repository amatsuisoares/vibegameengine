import type { Components, RuleAction, StateTransition } from '@vibe/shared';
import { runAction } from './actions';
import type { Entity } from './entity';
import { compileExpr, ExprError, type ExprScope } from './expr';
import type { Game } from './game';
import { matches } from './rules';
import { FIXED_DT, type GameEvent, type World } from './world';

/**
 * State machines: an entity with a `StateMachine` component is always in one of its named states
 * (idle, chase, sleeping...). Every frame, after the scene rules, the first transition whose
 * conditions all hold moves it to another state — transitions from any state first, then those of
 * the current state. A transition may require an expression (`when`, with `self`), a minimum time
 * in the state (`after`, ms) and an event of this frame (`event` + `match`; "$self" = this entity).
 * At most one transition per entity per frame; transitions to the current state are ignored.
 *
 * Changing state runs the old state's `exit` actions, emits "state_change" {entity, from, to},
 * runs the new state's `enter` actions (rule actions; target "$self") and calls the script hook
 * onStateChange(self, {from, to}, game). Scripts read and drive it through self.fsm.
 *
 * The machine decides *when* the state changes; what each state does is up to the game (enter/exit
 * actions, scripts reading self.fsm.state). An error disables that entity's machine until the scene
 * reloads and emits "state_error".
 */

export type StateMachineData = NonNullable<Components['StateMachine']>;

/** Live state of an entity's machine (kept on the Entity). `since` < 0: the initial state was not entered yet. */
export interface FsmState {
  state: string;
  previous: string | null;
  /** Frame the current state was entered. */
  since: number;
  failed?: boolean;
}

/** What the state machines need from the scripts (implemented by ScriptRunner). */
export interface StateHooks {
  stateChanged(e: Entity, change: { from: string | null; to: string }): void;
}

const MAX_DEPTH = 8;
const framesOf = (ms: number) => Math.max(0, Math.round(ms / 1000 / FIXED_DT));

export function fsmOf(e: Entity): FsmState | undefined {
  const sm = e.components.StateMachine;
  if (!sm) return undefined;
  return (e.fsm ??= { state: sm.initial, previous: null, since: -1 });
}

/** Time in the current state, in ms (0 before it is entered). */
export function stateMs(world: World, st: FsmState): number {
  return st.since < 0 ? 0 : Math.round(((world.frame - st.since) * 1000) / 60);
}

/** Runs the state machines of one world. Created per scene load (like rules and scripts). */
export class StateMachineRunner {
  private processed: number;
  private readonly compiled = new Map<string, (scope: ExprScope) => unknown>();
  private depth = 0;

  constructor(
    private readonly world: World,
    private readonly game: Game,
    private readonly hooks: StateHooks,
  ) {
    this.processed = world.emitted;
  }

  /** Once per frame, after the rules: enters initial states and takes transitions. */
  run() {
    const w = this.world;
    const count = Math.min(w.emitted - this.processed, w.events.length);
    this.processed = w.emitted;
    const fresh = count > 0 ? w.events.slice(-count) : [];
    for (const e of [...w.entities]) {
      if (w.status !== 'running') return;
      const sm = e.components.StateMachine;
      const st = fsmOf(e);
      if (!sm || !st || !e.active || st.failed) continue;
      try {
        if (st.since < 0) this.enterInitial(e, sm, st);
        if (st.failed || !e.active || w.status !== 'running') continue;
        const t = this.pick(e, sm, st, fresh);
        if (t) this.change(e, t.to);
      } catch (err) {
        this.fail(e, st, err);
      }
    }
  }

  /** Moves `e` to `to` now (scripts: self.fsm.go). Returns false if it already is in that state. */
  go(e: Entity, to: string): boolean {
    const sm = e.components.StateMachine;
    const st = fsmOf(e);
    if (!sm || !st) throw new Error(`entity "${e.id}" has no StateMachine`);
    if (st.since < 0) this.enterInitial(e, sm, st);
    return this.change(e, to);
  }

  private enterInitial(e: Entity, sm: StateMachineData, st: FsmState) {
    st.since = this.world.frame;
    this.world.emit('state_change', { entity: e.id, from: null, to: st.state });
    this.actions(e, sm.states[st.state]?.enter ?? [], st.state);
    this.hooks.stateChanged(e, { from: null, to: st.state });
  }

  private change(e: Entity, to: string): boolean {
    const sm = e.components.StateMachine!;
    const st = e.fsm!;
    if (!Object.hasOwn(sm.states, to)) throw new Error(`state "${to}" does not exist (states: ${Object.keys(sm.states).join(', ')})`);
    if (st.state === to) return false;
    if (this.depth >= MAX_DEPTH) throw new Error('state changes nested too deeply (does onStateChange or an enter action change state again?)');
    this.depth++;
    try {
      const from = st.state;
      this.actions(e, sm.states[from]?.exit ?? [], from);
      st.previous = from;
      st.state = to;
      st.since = this.world.frame;
      this.world.emit('state_change', { entity: e.id, from, to });
      this.actions(e, sm.states[to].enter, to);
      this.hooks.stateChanged(e, { from, to });
    } finally {
      this.depth--;
    }
    return true;
  }

  private pick(e: Entity, sm: StateMachineData, st: FsmState, fresh: GameEvent[]): StateTransition | null {
    const elapsed = this.world.frame - st.since;
    for (const t of [...sm.transitions, ...(sm.states[st.state]?.transitions ?? [])]) {
      if (t.to === st.state) continue;
      if (t.after !== undefined && elapsed < framesOf(t.after)) continue;
      if (t.event !== undefined && !fresh.some((ev) => ev.type === t.event && matches(ev, selfMatch(t.match, e.id)))) continue;
      if (t.when !== undefined && !this.eval(t.when, e.id)) continue;
      return t;
    }
    return null;
  }

  private actions(e: Entity, list: RuleAction[], state: string) {
    for (const a of list) {
      if (this.world.status !== 'running') return;
      runAction(this.world, a, (ref) => this.target(ref, e), {
        kind: 'state',
        data: { entity: e.id, state },
        label: `state "${state}" of "${e.id}"`,
        source: `state:${e.id}`,
      });
    }
  }

  private target(ref: string, self: Entity): Entity {
    if (ref === '$self') return self;
    const e = this.world.get(ref);
    if (!e) throw new Error(`entity "${ref}" no longer exists`);
    return e;
  }

  private eval(src: string, self: string): boolean {
    let fn = this.compiled.get(src);
    if (!fn) {
      fn = compileExpr(src);
      this.compiled.set(src, fn);
    }
    try {
      return !!fn({ game: this.game, self });
    } catch (err) {
      if (err instanceof ExprError) throw new Error(`expression "${src}": ${err.message}`);
      throw err;
    }
  }

  private fail(e: Entity, st: FsmState, err: unknown) {
    st.failed = true;
    const message = err instanceof Error ? err.message : String(err);
    this.world.console.error(`StateMachine of "${e.id}" (state "${st.state}"): ${message}\n(machine disabled until the scene reloads)`, 'fsm');
    this.world.emit('state_error', { entity: e.id, state: st.state, message });
  }
}

function selfMatch(match: StateTransition['match'], id: string): Record<string, unknown> | undefined {
  if (!match) return undefined;
  return Object.fromEntries(Object.entries(match).map(([k, v]) => [k, v === '$self' ? id : v]));
}
