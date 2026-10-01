import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatText, Game } from '../src';
import { enemy, ground, GROUND_TOP, makeGame, player, readProjectDir, trigger } from './helpers';

const REST_Y = GROUND_TOP - 16; // player center when standing (32px tall)

describe('physics', () => {
  it('player falls under gravity and lands on the ground', () => {
    const game = makeGame([player(100, 200), ground('g', 0, 1000)]);
    game.advance(2000);
    const p = game.entity('player')!;
    expect(p.y).toBeCloseTo(REST_Y, 5);
    expect(p.grounded).toBe(true);
    expect(p.components.Body!.vy).toBe(0);
  });

  it('walls block horizontal movement', () => {
    const wall = { id: 'wall', transform: { x: 216, y: 300 }, components: { Collider: { width: 32, height: 300 } } };
    const game = makeGame([player(), ground('g', 0, 1000), wall]);
    game.perform([{ type: 'hold', key: 'D', ms: 2000 }]);
    const p = game.entity('player')!;
    expect(p.x).toBeCloseTo(200 - 12, 5);
    expect(p.onWallRight).toBe(true);
  });

  it('one-way platforms can be jumped through from below and stood on', () => {
    const plat = { id: 'plat', transform: { x: 100, y: 358 }, components: { Collider: { width: 128, height: 16, oneWay: true } } };
    const game = makeGame([player(), ground('g', 0, 1000), plat]);
    game.step(5);
    game.perform([{ type: 'hold', key: 'Space', ms: 500 }, { type: 'wait', ms: 1000 }]);
    const p = game.entity('player')!;
    expect(p.grounded).toBe(true);
    expect(p.groundId).toBe('plat');
    expect(p.y).toBeCloseTo(350 - 16, 5);
  });
});

describe('platformer controller', () => {
  it('moves right with D and left with A, then stops', () => {
    const game = makeGame([player(), ground('g', 0, 2000)]);
    game.step(5);
    game.perform([{ type: 'hold', key: 'D', ms: 1000 }]);
    const p = game.entity('player')!;
    expect(p.x).toBeGreaterThan(260);
    const xAfterRight = p.x;
    game.perform([{ type: 'wait', ms: 300 }]);
    expect(p.components.Body!.vx).toBe(0);
    game.perform([{ type: 'hold', key: 'A', ms: 500 }]);
    expect(p.x).toBeLessThan(xAfterRight - 60);
  });

  it('full jump reaches ~jumpSpeed^2/(2g) and lands again', () => {
    const game = makeGame([player(), ground('g', 0, 1000)]);
    game.step(5);
    const p = game.entity('player')!;
    let minY = p.y;
    game.input.keyDown('Space');
    for (let i = 0; i < 40; i++) {
      game.step();
      minY = Math.min(minY, p.y);
    }
    game.input.keyUp('Space');
    const rise = REST_Y - minY;
    expect(rise).toBeGreaterThan(100);
    expect(rise).toBeLessThan(125);
    game.advance(1000);
    expect(p.grounded).toBe(true);
    expect(game.events(0, 'jump')).toHaveLength(1);
  });

  it('a short tap gives a lower jump than holding', () => {
    const game = makeGame([player(), ground('g', 0, 1000)]);
    game.step(5);
    const p = game.entity('player')!;
    let minY = p.y;
    game.perform([{ type: 'tap', key: 'Space', ms: 50 }]);
    for (let i = 0; i < 40; i++) {
      game.step();
      minY = Math.min(minY, p.y);
    }
    expect(REST_Y - minY).toBeLessThan(70);
    expect(REST_Y - minY).toBeGreaterThan(10);
  });

  it('cannot jump in mid-air unless maxJumps allows it', () => {
    const game = makeGame([player(100, 100), ground('g', 0, 1000)]);
    game.step(10);
    game.perform([{ type: 'tap', key: 'Space' }]);
    expect(game.events(0, 'jump')).toHaveLength(0);

    const dj = makeGame([player(100, 100, { PlatformerController: { maxJumps: 2 } }), ground('g', 0, 1000)]);
    dj.step(10);
    dj.perform([{ type: 'tap', key: 'Space' }]);
    expect(dj.events(0, 'jump')).toHaveLength(1);
  });
});

describe('interactions', () => {
  it('collects coins', () => {
    const coin = trigger('coin', 200, REST_Y, { Collectible: { score: 10 } });
    const game = makeGame([player(), ground('g', 0, 1000), coin], { vars: { coins: 0 } });
    game.perform([{ type: 'hold', key: 'D', ms: 1000 }]);
    expect(game.world.vars.coins).toBe(1);
    expect(game.world.vars.score).toBe(10);
    expect(game.entity('coin')).toBeUndefined();
    expect(game.events(0, 'collect')[0]).toMatchObject({ entity: 'coin', by: 'player' });
  });

  it('enemies damage the player, with invulnerability and knockback', () => {
    const game = makeGame([player(), ground('g', 0, 1000), enemy('e', 180)]);
    game.input.keyDown('D');
    const hit = game.waitUntil((g) => g.events(0, 'damage').length > 0, 2000);
    expect(hit.ok).toBe(true);
    const p = game.entity('player')!;
    expect(p.health).toBe(2);
    expect(p.invulnTimer).toBeGreaterThan(0);
    game.step(1);
    expect(p.components.Body!.vx).toBeLessThan(0); // knocked back
    game.advance(500); // still invulnerable
    expect(game.events(0, 'damage')).toHaveLength(1);
  });

  it('player loses when health reaches zero', () => {
    const game = makeGame([player(100, REST_Y, { Health: { max: 1, onDeath: 'lose' } }), ground('g', 0, 1000), enemy('e', 180)]);
    game.input.keyDown('D');
    game.advance(2000);
    expect(game.status).toBe('lost');
    expect(game.events(0, 'lose')).toHaveLength(1);
    const x = game.entity('player')!.x;
    game.advance(500);
    expect(game.entity('player')!.x).toBe(x); // simulation is frozen after the end
  });

  it('stomping an enemy kills it and bounces the player', () => {
    const game = makeGame([player(100, 250), ground('g', 0, 1000), enemy('e', 100, { Stompable: {} })]);
    const r = game.waitUntil((g) => g.events(0, 'stomp').length > 0, 2000);
    expect(r.ok).toBe(true);
    game.step();
    expect(game.entity('e')).toBeUndefined();
    expect(game.entity('player')!.health).toBe(3);
    expect(game.entity('player')!.components.Body!.vy).toBeLessThan(0);
  });

  it('reaching the goal wins', () => {
    const flag = trigger('flag', 300, REST_Y - 16, { Goal: {} }, 24, 64);
    const game = makeGame([player(), ground('g', 0, 1000), flag]);
    game.perform([{ type: 'hold', key: 'D', ms: 2000 }]);
    expect(game.status).toBe('won');
    expect(game.events(0, 'win')).toHaveLength(1);
  });

  it('goal requirements block the win until met', () => {
    const flag = trigger('flag', 300, REST_Y - 16, { Goal: { require: { coins: 1 } } }, 24, 64);
    const game = makeGame([player(), ground('g', 0, 1000), flag], { vars: { coins: 0 } });
    game.perform([{ type: 'hold', key: 'D', ms: 2000 }]);
    expect(game.status).toBe('running');
    expect(game.events(0, 'goal_blocked')[0]).toMatchObject({ missing: { coins: 1 } });
  });

  it('falling into a pit costs health and respawns at the last checkpoint', () => {
    const cp = trigger('cp', 150, REST_Y, { Checkpoint: {} }, 16, 48);
    const game = makeGame([player(), ground('g', 0, 300), cp], { height: 450, killY: 520 });
    game.input.keyDown('D');
    const r = game.waitUntil((g) => g.events(0, 'respawn').length > 0, 5000);
    game.input.keyUp('D');
    expect(r.ok).toBe(true);
    const p = game.entity('player')!;
    expect(p.health).toBe(2);
    expect(p.x).toBe(150);
    expect(game.events(0, 'checkpoint')).toHaveLength(1);
  });

  it('goal with loadScene switches scene and keeps variables', () => {
    const coin = trigger('coin', 150, REST_Y, { Collectible: {} });
    const door = trigger('door', 300, REST_Y, { Goal: { action: 'loadScene', scene: 'level2' } }, 24, 64);
    const game = makeGame([player(), ground('g', 0, 1000), coin, door], {}, [
      { id: 'level2', entities: [player(50), ground('g', 0, 500)] },
    ]);
    game.input.keyDown('D');
    const r = game.waitUntil((g) => g.world.scene.id === 'level2', 2000);
    expect(r.ok).toBe(true);
    expect(game.world.vars.coins).toBe(1);
    expect(game.entity('player')!.x).toBe(50); // fresh spawn in the new scene
  });
});

describe('AI behaviours', () => {
  it('patrol turns at ledges and never falls off', () => {
    const game = makeGame([ground('g', 0, 400), enemy('e', 350, { Patrol: { distance: 0, speed: 100 } })]);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < 600; i++) {
      game.step();
      const e = game.entity('e')!;
      minX = Math.min(minX, e.x);
      maxX = Math.max(maxX, e.x);
    }
    expect(game.entity('e')).toBeDefined();
    expect(maxX).toBeLessThanOrEqual(400);
    expect(minX).toBeGreaterThanOrEqual(0);
    expect(maxX - minX).toBeGreaterThan(300);
  });

  it('patrol stays within its distance', () => {
    const game = makeGame([ground('g', 0, 2000), enemy('e', 500, { Patrol: { distance: 100 } })]);
    const xs: number[] = [];
    for (let i = 0; i < 600; i++) {
      game.step();
      xs.push(game.entity('e')!.x);
    }
    expect(Math.min(...xs)).toBeGreaterThan(445);
    expect(Math.max(...xs)).toBeLessThan(555);
  });

  it('FollowTarget chases the player only within range', () => {
    const game = makeGame([
      player(100),
      ground('g', 0, 2000),
      enemy('near', 250, { FollowTarget: { speed: 60 }, Damage: { amount: 0 } }),
      enemy('far', 900, { FollowTarget: { speed: 60 }, Damage: { amount: 0 } }),
    ]);
    game.advance(1000);
    expect(game.entity('near')!.x).toBeLessThan(220);
    expect(game.entity('far')!.x).toBe(900);
  });
});

describe('determinism and state', () => {
  const run = () => {
    const game = makeGame([player(), ground('g', 0, 2000), enemy('e', 600, { Patrol: {}, Stompable: {} })]);
    game.perform([
      { type: 'hold', key: 'D', ms: 700 },
      { type: 'tap', key: 'Space', ms: 200 },
      { type: 'hold', key: 'D', ms: 900 },
      { type: 'wait', ms: 500 },
    ]);
    return JSON.stringify({ state: game.getState({ components: true }), events: game.events() });
  };

  it('same inputs produce identical state', () => {
    expect(run()).toBe(run());
  });

  it('getState filters entities and exposes gameplay fields', () => {
    const game = makeGame([player(), ground('g', 0, 1000), enemy('e', 600)]);
    game.step(10);
    const s = game.getState({ tags: ['player'] });
    expect(s.entities).toHaveLength(1);
    expect(s.entities[0]).toMatchObject({ id: 'player', health: 3, maxHealth: 3, grounded: true, width: 24 });
    expect(s.entityCount).toBe(3);
    expect(s.frame).toBe(10);
    expect(s.status).toBe('running');
  });

  it('restart resets the world', () => {
    const game = makeGame([player(), ground('g', 0, 1000)]);
    game.perform([{ type: 'hold', key: 'D', ms: 500 }]);
    game.restart();
    expect(game.entity('player')!.x).toBe(100);
    expect(game.input.snapshot().keys).toEqual([]);
  });

  it('formats HUD text placeholders', () => {
    const game = makeGame([player()], { vars: { coins: 2 } });
    expect(formatText('C:{coins} HP:{player.health}/{player.maxHealth} {nope}', game.world)).toBe('C:2 HP:3/3 {nope}');
  });
});

describe('demo project', () => {
  const dir = fileURLToPath(new URL('../../../test-fixtures/demo-platformer', import.meta.url));

  it('loads, validates and the player lands on the ground', () => {
    const game = Game.fromRaw(readProjectDir(dir));
    game.advance(500);
    const s = game.getState({ ids: ['player'] });
    expect(s.entities[0].grounded).toBe(true);
    expect(s.vars.coins).toBe(0);
    expect(game.console.read().some((l) => l.message.includes('level1'))).toBe(true);
  });

  it('the first coin can be collected by walking right', () => {
    const game = Game.fromRaw(readProjectDir(dir));
    game.input.keyDown('D');
    const r = game.waitUntil((g) => g.world.vars.coins === 1, 3000);
    expect(r.ok).toBe(true);
  });

  it('can be won by a simple bot that walks right and jumps over enemies and gaps', () => {
    const game = Game.fromRaw(readProjectDir(dir));
    game.input.keyDown('D');
    let lastJump = -99;
    for (let f = 0; f < 60 * 25 && game.status === 'running'; f++) {
      const p = game.entity('player')!;
      const enemyAhead = game.world.withTag('enemy').some((e) => e.x > p.x && e.x - p.x < 90 && Math.abs(e.y - p.y) < 40);
      const gapAhead = !game.world.withTag('ground').some((g) => Math.abs(g.x - (p.x + 22)) < g.components.Collider!.width / 2);
      if ((enemyAhead || gapAhead) && p.grounded && f - lastJump > 20) {
        game.input.keyDown('Space');
        lastJump = f;
      }
      if (f - lastJump === 14) game.input.keyUp('Space');
      game.step(1);
    }
    expect(game.status).toBe('won');
    expect(game.events(0, 'goal')).toHaveLength(1);
  });
});
