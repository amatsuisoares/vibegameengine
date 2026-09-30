import type { World } from '../world';

export function animationSystem(world: World, dt: number) {
  for (const e of world.entities) {
    if (!e.active) continue;
    const sprite = e.components.Sprite;
    const body = e.components.Body;
    if (!sprite) continue;

    if (sprite.faceVelocity && body && Math.abs(body.vx) > 1) sprite.flipX = body.vx < 0;

    const anim = e.components.Animator;
    if (!anim) continue;
    let name = e.animName ?? anim.initial;
    if (anim.auto && body) {
      const wanted = !e.grounded ? (body.vy < 0 ? 'jump' : 'fall') : Math.abs(body.vx) > 5 ? 'run' : 'idle';
      if (anim.animations[wanted]) name = wanted;
      else if (wanted === 'fall' && anim.animations.jump) name = 'jump';
      else if (anim.animations[anim.initial]) name = anim.initial;
    }
    if (name !== e.animName) {
      e.animName = name;
      e.animTime = 0;
    }
    const clip = anim.animations[name];
    if (!clip) continue;
    e.animTime += dt;
    let i = Math.floor(e.animTime * clip.fps);
    i = clip.loop ? i % clip.frames.length : Math.min(i, clip.frames.length - 1);
    sprite.frame = clip.frames[i];
  }
}
