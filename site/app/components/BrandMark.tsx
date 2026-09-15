import type { ReactElement } from 'react';
import { marks } from '../icons';
import { customMarks } from './CustomMarks';

/**
 * Follow an alias to the package whose mark is actually drawn.
 *
 * A voice adapter shares its SMS sibling's brand — @msgly/plivo-voice is the
 * same company as @msgly/plivo — so rather than duplicating artwork the
 * generator emits an alias. One hop is enough; the loop guard is there so a
 * mistaken alias cycle cannot hang a render.
 */
function resolve(pkg: string): string {
  let current = pkg;
  for (let hops = 0; hops < 4; hops++) {
    const mark = marks[current];
    if (mark?.kind !== 'alias') return current;
    current = mark.of;
  }
  return current;
}

/** The mark's artwork on a 24x24 grid, for embedding in a caller's <svg>. */
export function markGlyph(pkg: string): ReactElement | null {
  const target = resolve(pkg);

  const custom = customMarks[target];
  if (custom) return custom.node;

  const mark = marks[target];
  if (mark?.kind === 'path') return <path d={mark.d} fill={mark.hex} />;
  return null;
}

export function markColor(pkg: string) {
  const target = resolve(pkg);
  const mark = marks[target];
  return customMarks[target]?.hex ?? (mark?.kind === 'path' ? mark.hex : undefined) ?? '#838ca3';
}

/** A channel's real brand logo. */
export default function BrandMark({ pkg, size = 22 }: { pkg: string; size?: number }) {
  const glyph = markGlyph(pkg);
  if (!glyph) return null;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-hidden focusable="false">
      {glyph}
    </svg>
  );
}
