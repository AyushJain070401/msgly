import type { ReactElement } from 'react';
import { marks } from '../icons';
import { customMarks } from './CustomMarks';

/** The mark's artwork on a 24x24 grid, for embedding in a caller's <svg>. */
export function markGlyph(pkg: string): ReactElement | null {
  const custom = customMarks[pkg];
  if (custom) return custom.node;

  const mark = marks[pkg];
  if (mark?.kind === 'path') return <path d={mark.d} fill={mark.hex} />;
  return null;
}

export function markColor(pkg: string) {
  return customMarks[pkg]?.hex ?? marks[pkg]?.hex ?? '#838ca3';
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
