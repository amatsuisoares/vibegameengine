import type { Entity } from '../entity';
import { fsmOf } from '../fsm';
import type { World } from '../world';

/**
 * Animation controller. Each frame the Animator of an entity picks one clip, in this order:
 *   1. a clip played by a script (self.anim.play) — until a non-looping one ends (then `next`, or back to 2-4)
 *   2. the StateMachine state: `states[state]`, or a clip with the state's name
 *   3. auto (with a Body): jump / fall / run / idle from the body state
 *   4. the last base clip (starts at `initial`; a non-looping one moves on to `next` when it ends)
 * and shows its frame (spritesheet index, or an image asset id). Time advances by dt * `speed`.
 * Frames listed in `events` emit an event of that type {entity, anim, frame} when they show; a
 * non-looping clip emits "anim_end" {entity, anim} once when it ends.
 */
export function animationSystem(world: World, dt: number) {
  for (const e of world.entities) {
    if (!e.active) continue;
    const sprite = e.components.Sprite;
    const body = e.components.Body;
    if (!sprite) continue;

    if (sprite.faceVelocity && body && Math.abs(body.vx) > 1) sprite.flipX = body.vx < 0;

    const anim = e.components.Animator;
    if (!anim) continue;
    const name = pickClip(e);
    if (name !== e.animName) {
      e.animName = name;
      e.animTime = 0;
      e.animStep = -1;
      e.animEnded = false;
    }
    const clip = name === null ? undefined : anim.animations[name];
    if (!clip) continue;
    e.animTime += dt * anim.speed;
    const step = Math.floor(e.animTime * clip.fps + 1e-9);
    const len = clip.frames.length;
    // Every frame index shown since the previous step (fast clips may skip some), for frame events.
    for (let s = Math.max(e.animStep + 1, step - len + 1); s <= step && e.animStep < step; s++) {
      if (!clip.loop && s >= len) break;
      const event = clip.events?.[String(s % len)];
      if (event) world.emit(event, { entity: e.id, anim: name, frame: s % len });
    }
    e.animStep = Math.max(e.animStep, step);
    const i = clip.loop ? step % len : Math.min(step, len - 1);
    const frame = clip.frames[i];
    if (typeof frame === 'string') {
      sprite.asset = frame;
      sprite.frame = 0;
    } else {
      if (clip.asset) sprite.asset = clip.asset;
      sprite.frame = frame;
    }
    if (!clip.loop && step >= len && !e.animEnded) {
      e.animEnded = true;
      world.emit('anim_end', { entity: e.id, anim: name });
      // A finished one-shot moves on: the script's override to `next` (or off), the base clip to `next`.
      if (e.animOverride === name) e.animOverride = clip.next && anim.animations[clip.next] ? clip.next : null;
      else if (clip.next && anim.animations[clip.next] && e.animBase === name) e.animBase = clip.next;
    }
  }
}

/** Index (in the clip's frames) of the frame showing, or -1 without a clip. */
export function animFrameIndex(e: Entity): number {
  const clip = e.animName === null ? undefined : e.components.Animator?.animations[e.animName];
  if (!clip || e.animStep < 0) return -1;
  return clip.loop ? e.animStep % clip.frames.length : Math.min(e.animStep, clip.frames.length - 1);
}

function pickClip(e: Entity): string | null {
  const anim = e.components.Animator!;
  const has = (n: string | null | undefined): n is string => !!n && Object.hasOwn(anim.animations, n);
  if (has(e.animOverride)) return e.animOverride;
  const state = fsmOf(e)?.state;
  if (state !== undefined) {
    const mapped = anim.states?.[state] ?? state;
    if (has(mapped)) return mapped;
  }
  const body = e.components.Body;
  if (anim.auto && body) {
    const wanted = !e.grounded ? (body.vy < 0 ? 'jump' : 'fall') : Math.abs(body.vx) > 5 ? 'run' : 'idle';
    if (has(wanted)) return wanted;
    if (wanted === 'fall' && has('jump')) return 'jump';
  }
  if (!has(e.animBase)) e.animBase = anim.initial;
  return has(e.animBase) ? e.animBase : null;
}
