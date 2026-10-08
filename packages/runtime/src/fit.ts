/**
 * Letterbox: the largest size of a `width`×`height` game that fits a `boxW`×`boxH` window keeping
 * its proportions, centered (the rest of the window shows the background). Sizes are CSS pixels;
 * the canvas keeps its own resolution and the input maps through its on-screen box.
 */
export function fitViewport(boxW: number, boxH: number, width: number, height: number) {
  const scale = Math.max(0, Math.min(boxW / width, boxH / height));
  const w = Math.floor(width * scale);
  const h = Math.floor(height * scale);
  return { scale, width: w, height: h, left: Math.floor((boxW - w) / 2), top: Math.floor((boxH - h) / 2) };
}
