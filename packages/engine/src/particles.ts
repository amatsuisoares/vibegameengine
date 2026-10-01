import { ParticleEmitterSchema, type Components } from '@vibe/shared';
import type { Entity } from './entity';
import { Rng } from './rng';
import type { World } from './world';

/**
 * Particles: light visual effects (smoke, dust, hearts, stars, confetti, sparks). They are not
 * entities: one ParticleSystem per world keeps a flat list, moved once per frame (velocity, gravity,
 * drag, lifetime). Emitters are entities with a `ParticleEmitter` (continuous `rate`, a `burst` at
 * start, scripted or "burst" action bursts); scripts can also emit at any point. Randomness comes
 * from a separate RNG derived from the game seed, so effects replay exactly (headless and
 * screenshots) without changing the game's own random draws. Rendering only reads them.
 */

export type EmitterData = NonNullable<Components['ParticleEmitter']>;
export type EmitterOptions = Partial<EmitterData>;

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived / to live. */
  age: number;
  life: number;
  size: number;
  sizeEnd: number;
  color: string;
  shape: 'circle' | 'rect';
  text?: string;
  fade: boolean;
  gravity: number;
  drag: number;
  layer: number;
  /** Emitter entity id. */
  owner?: string;
}

/** Most particles alive in a scene; new ones are skipped beyond it. */
export const MAX_PARTICLES = 2000;
const DEG = Math.PI / 180;

export class ParticleSystem {
  readonly particles: Particle[] = [];
  private rng = new Rng(0x5eed);
  /** Emitters already started (initial burst done) and their fractional emission. */
  private readonly started = new WeakSet<Entity>();
  private readonly carry = new WeakMap<Entity, number>();

  constructor(private readonly world: World) {}

  reseed(seed: number) {
    this.rng = new Rng((seed ^ 0x5eed5eed) >>> 0);
  }

  /** Emitters (initial bursts, continuous rate), then moves and ages every particle. */
  run(dt: number) {
    const w = this.world;
    for (const e of w.entities) {
      const em = e.components.ParticleEmitter;
      if (!em || !e.active) continue;
      if (!this.started.has(e)) {
        this.started.add(e);
        if (em.burst > 0) this.burst(e, em.burst);
      }
      if (em.emitting && em.rate > 0) {
        let acc = (this.carry.get(e) ?? 0) + em.rate * dt;
        const n = Math.floor(acc);
        acc -= n;
        this.carry.set(e, acc);
        if (n > 0) this.spawn(e.x + em.offsetX, e.y + em.offsetY, n, em, e.id);
      }
    }
    const ps = this.particles;
    let keep = 0;
    for (const p of ps) {
      p.age += dt;
      if (p.age >= p.life) continue;
      p.vy += p.gravity * dt;
      if (p.drag > 0) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ps[keep++] = p;
    }
    ps.length = keep;
  }

  /** Emits `count` particles from an entity's emitter now; returns how many were created. */
  burst(e: Entity, count?: number): number {
    const em = e.components.ParticleEmitter;
    if (!em) throw new Error(`entity "${e.id}" has no ParticleEmitter`);
    const n = count ?? (em.burst > 0 ? em.burst : 10);
    const made = this.spawn(e.x + em.offsetX, e.y + em.offsetY, n, em, e.id);
    this.world.emit('particles', { entity: e.id, count: made });
    return made;
  }

  /** Emits particles at a world point with the given emitter settings (defaults for the rest). */
  emitAt(x: number, y: number, count: number, options: EmitterOptions = {}): number {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('emitParticles: x and y must be finite numbers');
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('emitParticles: count must be an integer from 1 to 500');
    const r = ParticleEmitterSchema.safeParse(options);
    if (!r.success) throw new Error(`emitParticles: ${r.error.issues.map((i) => `${i.path.join('.') || 'options'}: ${i.message}`).join('; ')}`);
    const made = this.spawn(x, y, count, r.data);
    this.world.emit('particles', { x: Math.round(x), y: Math.round(y), count: made });
    return made;
  }

  /** Particles alive from an emitter. */
  aliveOf(id: string): number {
    let n = 0;
    for (const p of this.particles) if (p.owner === id) n++;
    return n;
  }

  private spawn(x: number, y: number, count: number, em: EmitterData, owner?: string): number {
    const room = Math.min(MAX_PARTICLES - this.particles.length, owner ? em.max - this.aliveOf(owner) : em.max);
    const n = Math.max(0, Math.min(count, room));
    const vary = (v: number) => v * (1 + (this.rng.next() * 2 - 1) * em.jitter);
    for (let i = 0; i < n; i++) {
      const angle = (em.angle + (this.rng.next() - 0.5) * em.spread) * DEG;
      const speed = vary(em.speed);
      const size = Math.max(0.5, vary(em.size));
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        age: 0,
        life: Math.max(0.05, vary(em.lifeMs) / 1000),
        size,
        sizeEnd: em.sizeEnd === undefined ? size : em.sizeEnd * (size / em.size),
        color: em.colors[Math.floor(this.rng.next() * em.colors.length)],
        shape: em.shape,
        ...(em.text !== undefined && { text: em.text }),
        fade: em.fade,
        gravity: em.gravity,
        drag: em.drag,
        layer: em.layer,
        ...(owner && { owner }),
      });
    }
    return n;
  }
}
