import type { Game, GameEvent, LogEntry } from '@vibe/engine';
import type { Project } from '@vibe/shared';
import type { Check } from './scenario';

/**
 * Diagnostic report for a failed verification: evidence gathered from the engine's structured
 * state (the entities a failing check is about, their events, who writes the variables it reads,
 * what happened just before) and a ranking of the systems most likely involved, each with why.
 * Heuristic and generic: it never knows game rules, only components, events, rules and scripts.
 */

export interface SystemGuess {
  system: string;
  score: number;
  why: string[];
}

export interface FailureEvidence {
  check: string;
  frame: number;
  entities?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  events?: Record<string, unknown>;
}

export interface Diagnosis {
  failures: FailureEvidence[];
  likelySystems: SystemGuess[];
  errors?: { frame: number; source?: string; message: string }[];
  /** Notable events of the last frames before the end (most recent last). */
  timeline: string[];
}

/** Component → the engine system that runs it. */
const COMPONENT_SYSTEM: Record<string, string> = {
  PlatformerController: 'controller (movement/jump)',
  Body: 'physics',
  Collider: 'collision',
  Patrol: 'movement (Patrol)',
  Mover: 'movement (Mover)',
  FollowTarget: 'movement (FollowTarget)',
  Health: 'health/damage',
  Damage: 'health/damage',
  Stompable: 'health/damage',
  Collectible: 'collectible',
  Goal: 'goal',
  Checkpoint: 'checkpoint',
  Interactable: 'interaction',
  StateMachine: 'state machine',
  UtilityAI: 'utility AI',
  Animator: 'animation',
  NavAgent: 'pathfinding',
  ParticleEmitter: 'particles',
  Text: 'text/UI',
};

/** Event type → systems that produce it (a missing event points at them). */
const EVENT_SYSTEMS: Record<string, string[]> = {
  collect: ['collision', 'collectible'],
  interact: ['interaction', 'input'],
  interact_blocked: ['interaction'],
  click: ['input'],
  state_change: ['state machine'],
  ai_choice: ['utility AI'],
  particles: ['particles'],
  sound: ['audio'],
  music: ['audio'],
  damage: ['health/damage', 'collision'],
  death: ['health/damage'],
  stomp: ['health/damage', 'collision'],
  fell: ['health/damage', 'physics'],
  jump: ['controller (movement/jump)', 'input'],
  goal: ['goal', 'collision'],
  goal_blocked: ['goal'],
  win: ['goal', 'rules'],
  lose: ['health/damage', 'rules'],
  checkpoint: ['checkpoint', 'collision'],
  respawn: ['checkpoint', 'health/damage'],
  nav_arrived: ['pathfinding'],
  nav_failed: ['pathfinding'],
  tween_end: ['tweens'],
  anim_end: ['animation'],
  spawn: ['rules', 'scripts'],
  rule: ['rules'],
  scene_loaded: ['scenes'],
};

/** Console source → system. */
const SOURCE_SYSTEM: Record<string, string> = {
  rules: 'rules',
  fsm: 'state machine',
  ai: 'utility AI',
  interact: 'interaction',
  engine: 'engine (crash)',
};

/** Frequent, low-information events left out of the timeline. */
const NOISY = new Set(['sound', 'music', 'tween_end', 'anim_end', 'rule']);
const TIMELINE_FRAMES = 180;

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Entity ids and variable names a check is about. */
function subjects(c: Check, raw?: Record<string, unknown>) {
  const ids = new Set<string>();
  const vars = new Set<string>();
  const events = new Set<string>();
  if (c.expr) {
    const src = c.expr.replace(/^waitUntil /, '');
    for (const m of src.matchAll(/\b(?:entity|exists|distance|pathDistance)\(([^)]*)\)/g)) {
      for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) ids.add(s[1]);
    }
    for (const m of src.matchAll(/\bvars\.([A-Za-z_$][\w$]*)|\bvars\[['"]([^'"]+)['"]\]/g)) vars.add(m[1] ?? m[2]);
    for (const m of src.matchAll(/\bevents\(['"]([^'"]+)['"]\)/g)) events.add(m[1]);
  } else if (raw) {
    for (const k of ['id', 'target']) if (typeof raw[k] === 'string') ids.add(raw[k] as string);
    if (typeof raw.var === 'string') vars.add(raw.var);
    if (typeof raw.event === 'string') events.add(raw.event);
    const match = raw.match as Record<string, unknown> | undefined;
    for (const v of Object.values(match ?? {})) if (typeof v === 'string') ids.add(v);
  }
  return { ids, vars, events };
}

/** True when an event mentions an entity (any field equal to its id). */
const mentions = (ev: GameEvent, id: string) => Object.entries(ev).some(([k, v]) => k !== 'type' && v === id);

function describeEvent(ev: GameEvent) {
  const { frame, type, ...rest } = ev;
  const fields = Object.entries(rest)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? r2(v) : v}`)
    .join(' ');
  return `@${frame} ${type}${fields ? ` ${fields}` : ''}`;
}

export function diagnose(
  game: Game,
  project: Project,
  scripts: Record<string, string>,
  failed: { check: Check; raw?: Record<string, unknown> }[],
  errors: LogEntry[],
): Diagnosis {
  // Per system: total score and each reason with its weight (strongest reasons are listed first).
  const guesses = new Map<string, { score: number; why: Map<string, number> }>();
  const guess = (system: string, score: number, why: string) => {
    const g = guesses.get(system) ?? { score: 0, why: new Map<string, number>() };
    g.score += score;
    g.why.set(why, Math.max(score, g.why.get(why) ?? 0));
    guesses.set(system, g);
  };
  const all = game.events();
  const startScene = project.scenes[project.config.startScene];
  const atStart = new Set((startScene?.entities ?? []).map((e) => e.id));

  const failures = failed.map(({ check: c, raw }) => {
    const label = c.name ?? c.expr ?? c.check ?? '?';
    const { ids, vars, events } = subjects(c, raw);
    const out: FailureEvidence = { check: label, frame: c.frame };

    // Entities: their state now, or how they disappeared.
    if (ids.size) {
      out.entities = {};
      for (const id of ids) {
        const e = game.entity(id);
        const related = all.filter((ev) => mentions(ev, id));
        const recent = related.slice(-4).map(describeEvent);
        if (!e) {
          const spawned = all.find((ev) => ev.type === 'spawn' && ev.entity === id);
          out.entities[id] = {
            exists: false,
            ...(atStart.has(id) ? { wasInStartScene: true } : spawned ? { spawnedAt: spawned.frame } : { neverSeen: true }),
            ...(recent.length && { lastEvents: recent }),
          };
          if (!atStart.has(id) && !spawned) guess('scene setup', 4, `entity "${id}" never existed (wrong id, or it is created later / in another scene)`);
          continue;
        }
        const snap = game.getState({ ids: [id] }).entities[0];
        const comps = Object.keys(e.components);
        out.entities[id] = {
          x: snap.x,
          y: snap.y,
          ...(snap.vx !== undefined && { vx: snap.vx, vy: snap.vy }),
          ...(snap.grounded !== undefined && { grounded: snap.grounded }),
          ...(!e.enabled && { enabled: false }),
          components: comps,
          ...(snap.state !== undefined && { state: snap.state }),
          ...(snap.ai && { ai: snap.ai.choice }),
          ...(snap.nav && { nav: snap.nav }),
          ...(snap.interactable && { interactable: snap.interactable }),
          ...(snap.health !== undefined && { health: snap.health }),
          ...(recent.length && { lastEvents: recent }),
        };
        if (!e.enabled) guess('scene setup', 2, `entity "${id}" is disabled`);
        for (const comp of comps) {
          if (comp === 'Script') {
            const file = (e.components.Script as { src: string }).src;
            guess(`script ${file}`, 1, `"${id}" runs ${file}`);
          } else if (COMPONENT_SYSTEM[comp]) guess(COMPONENT_SYSTEM[comp], 1, `"${id}" has ${comp}`);
        }
        for (const ev of related.filter((x) => x.type === 'interact_blocked').slice(-1)) {
          guess('interaction', 3, `interaction with "${id}" was blocked (${String(ev.reason)})`);
        }
      }
    }

    // What the check is about.
    const kind = raw?.assert as string | undefined;
    if (kind === 'entityAt' || kind === 'entityNear' || (c.expr && /\.(x|y|vx|vy|grounded)\b|distance\(/.test(c.expr))) {
      for (const id of ids) {
        const e = game.entity(id);
        if (!e) continue;
        if (e.components.NavAgent) guess('pathfinding', 2, `position of "${id}" (NavAgent)`);
        if (e.components.PlatformerController) guess('controller (movement/jump)', 2, `position of "${id}" (PlatformerController)`);
        if (e.components.Body) guess('physics', 1, `position of "${id}" (Body)`);
        for (const m of ['Patrol', 'Mover', 'FollowTarget']) if (e.components[m as keyof typeof e.components]) guess(COMPONENT_SYSTEM[m], 2, `position of "${id}" (${m})`);
      }
    }
    if (kind === 'state' || (c.expr && /\.state\b/.test(c.expr))) {
      for (const id of ids) {
        const e = game.entity(id);
        guess('state machine', 2, `state of "${id}"`);
        if (e?.components.UtilityAI) guess('utility AI', 1, `"${id}" also has a UtilityAI that changes states`);
      }
    }
    if (kind === 'gameWon' || kind === 'gameLost' || kind === 'status' || (c.expr && /\bstatus\b/.test(c.expr))) {
      guess('goal', 1, 'game status');
      guess('rules', 1, 'game status (win/lose actions)');
    }
    if (kind === 'scene' || (c.expr && /\bscene\b/.test(c.expr))) guess('scenes', 2, 'current scene (loadScene)');

    // Variables: who writes them.
    if (vars.size) {
      out.variables = {};
      for (const name of vars) {
        const writers: string[] = [];
        for (const [sid, scene] of Object.entries(project.scenes)) {
          for (const rule of scene.rules ?? []) {
            const json = JSON.stringify(rule.do);
            if (json.includes(`"var":"${name}"`)) writers.push(`rule ${sid}/${rule.id}`);
          }
        }
        // Components that change variables: Collectible (its variable, and score).
        const collectors = new Set<string>();
        const visit = (where: string, comps: { Collectible?: { variable: string; score: number } } | undefined) => {
          const col = comps?.Collectible;
          if (col && (col.variable === name || (name === 'score' && col.score))) collectors.add(where);
        };
        for (const [sid, scene] of Object.entries(project.scenes)) for (const e of scene.entities) visit(`${sid}/${e.id}`, e.components as never);
        for (const [pid, prefab] of Object.entries(project.prefabs ?? {})) visit(`prefab ${pid}`, prefab.components as never);
        if (collectors.size) writers.push(`Collectible of ${[...collectors].slice(0, 4).join(', ')}${collectors.size > 4 ? ', ...' : ''}`);
        const pattern = new RegExp(`vars\\.${name}\\b|vars\\[['"]${name}['"]\\]`);
        for (const [file, src] of Object.entries(scripts)) if (pattern.test(src)) writers.push(file);
        out.variables[name] = { value: game.world.vars[name] ?? null, ...(writers.length ? { writtenBy: writers } : { writtenBy: 'nobody (no rule or script mentions it)' }) };
        for (const w of writers) guess(w.startsWith('rule ') ? 'rules' : w.startsWith('Collectible') ? 'collectible' : `script ${w}`, 2, `writes vars.${name}`);
        if (!writers.length) guess('scene setup', 1, `nothing writes vars.${name}`);
      }
    }

    // Events the check counts: what happened instead.
    if (events.size) {
      out.events = {};
      for (const type of events) {
        const seen = all.filter((ev) => ev.type === type);
        out.events[type] = { count: seen.length, ...(seen.length && { last: seen.slice(-3).map(describeEvent) }) };
        for (const s of EVENT_SYSTEMS[type] ?? []) guess(s, seen.length ? 1 : 2, seen.length ? `"${type}" happened, but not as expected` : `no "${type}" event happened`);
      }
    }
    return out;
  });

  // Runtime errors are the strongest signal.
  for (const err of errors) {
    const file = /([\w./-]+\.js)/.exec(`${err.source ?? ''} ${err.message}`)?.[1];
    const sys = err.source && SOURCE_SYSTEM[err.source] ? SOURCE_SYSTEM[err.source] : file ? `script ${file}` : 'scripts';
    guess(sys, 4, `runtime error: ${err.message.split('\n')[0].slice(0, 100)}`);
  }

  const end = game.frame;
  const timeline = all
    .filter((ev) => ev.frame >= end - TIMELINE_FRAMES && !NOISY.has(ev.type))
    .slice(-15)
    .map(describeEvent);
  return {
    failures,
    likelySystems: [...guesses]
      .map(([system, g]): SystemGuess => ({ system, score: g.score, why: [...g.why].sort((a, b) => b[1] - a[1]).map(([w]) => w) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 6),
    ...(errors.length && { errors: errors.slice(0, 5).map((e) => ({ frame: e.frame, ...(e.source && { source: e.source }), message: e.message.split('\n')[0] })) }),
    timeline,
  };
}
