import type { Project } from '../../types';

// Thumbnails are drawn from the project's own geometry rather than screenshotting the live
// editor. A screenshot would depend on the current pan, zoom, active level and whatever
// dialog happens to be open; this is deterministic, cheap, and produces the same image
// whether the project was saved from the 2D canvas, the 3D viewer or a wizard.
const THUMB_WIDTH = 320;
const THUMB_HEIGHT = 200;
const PADDING = 12;

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  weight: number;
}

const collectSegments = (project: Project): Segment[] => {
  const segments: Segment[] = [];
  for (const element of project.elements || []) {
    const { p1, p2 } = element;
    if (!p1 || !p2) continue;
    // Walls carry the plan's readable outline; openings and annotations would only add
    // noise at 320px wide.
    const weight = element.type === 'wall' ? 2.2 : 1;
    if (element.type !== 'wall' && element.type !== 'room' && element.type !== 'line') continue;
    segments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, weight });
  }
  return segments;
};

/**
 * A small JPEG data URL of the project's plan, or null when there is nothing to draw or no
 * DOM to draw with. Callers treat a null as "save without a thumbnail" — it is never worth
 * failing a save over.
 */
export const renderProjectThumbnail = (project: Project | null): string | null => {
  if (!project || typeof document === 'undefined') return null;

  const segments = collectSegments(project);
  if (segments.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.x1, s.x2);
    minY = Math.min(minY, s.y1, s.y2);
    maxX = Math.max(maxX, s.x1, s.x2);
    maxY = Math.max(maxY, s.y1, s.y2);
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (!Number.isFinite(spanX) || !Number.isFinite(spanY) || (spanX === 0 && spanY === 0)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = THUMB_WIDTH;
  canvas.height = THUMB_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, THUMB_WIDTH, THUMB_HEIGHT);

  const scale = Math.min(
    (THUMB_WIDTH - PADDING * 2) / (spanX || 1),
    (THUMB_HEIGHT - PADDING * 2) / (spanY || 1),
  );
  const offsetX = (THUMB_WIDTH - spanX * scale) / 2;
  const offsetY = (THUMB_HEIGHT - spanY * scale) / 2;
  const toX = (x: number) => offsetX + (x - minX) * scale;
  const toY = (y: number) => offsetY + (y - minY) * scale;

  ctx.lineCap = 'round';
  ctx.strokeStyle = '#0f172a';
  for (const s of segments) {
    ctx.lineWidth = s.weight;
    ctx.beginPath();
    ctx.moveTo(toX(s.x1), toY(s.y1));
    ctx.lineTo(toX(s.x2), toY(s.y2));
    ctx.stroke();
  }

  try {
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
};
