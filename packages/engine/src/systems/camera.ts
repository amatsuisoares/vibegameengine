import { clamp } from '../math';
import type { World } from '../world';

export function cameraSystem(world: World) {
  const cfg = world.scene.camera;
  const cam = world.camera;
  const viewW = world.config.width / cam.zoom;
  const viewH = world.config.height / cam.zoom;

  const target = cfg.follow ? world.get(cfg.follow) : undefined;
  if (target) {
    const tx = target.x - viewW / 2;
    const ty = target.y - viewH / 2;
    const k = world.cameraInitialized ? cfg.lerp : 1;
    cam.x += (tx - cam.x) * k;
    cam.y += (ty - cam.y) * k;
  }
  world.cameraInitialized = true;

  if (cfg.clampToBounds) {
    cam.x = clamp(cam.x, 0, Math.max(0, world.scene.width - viewW));
    cam.y = clamp(cam.y, 0, Math.max(0, world.scene.height - viewH));
  }
}

export function screenToWorld(world: World, sx: number, sy: number) {
  return { x: world.camera.x + sx / world.camera.zoom, y: world.camera.y + sy / world.camera.zoom };
}

export function worldToScreen(world: World, wx: number, wy: number) {
  return { x: (wx - world.camera.x) * world.camera.zoom, y: (wy - world.camera.y) * world.camera.zoom };
}
