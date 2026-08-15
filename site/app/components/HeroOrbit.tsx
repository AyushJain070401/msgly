import { channels } from '../data';
import { markGlyph } from './BrandMark';

const C = 220; // centre
const INNER_R = 122;
const OUTER_R = 194;
const NODE_R = 19;

const adapters = channels.filter((c) => c.category !== 'Core');
const inner = adapters.slice(0, 11);
const outer = adapters.slice(11);

type Node = { pkg: string; x: number; y: number; i: number; r: number };

function place(list: typeof adapters, radius: number, offset: number, from: number): Node[] {
  return list.map((c, i) => {
    const angle = ((i + offset) / list.length) * Math.PI * 2 - Math.PI / 2;
    return {
      pkg: c.pkg,
      x: C + Math.cos(angle) * radius,
      y: C + Math.sin(angle) * radius,
      i: from + i,
      r: radius,
    };
  });
}

/** One hub, all 27 channels — pulses travel outward along every spoke. */
export default function HeroOrbit() {
  const nodes = [...place(inner, INNER_R, 0, 0), ...place(outer, OUTER_R, 0.5, inner.length)];

  return (
    <div className="orbit" aria-hidden>
      <svg viewBox="0 0 440 440" className="orbit-svg">
        <defs>
          <radialGradient id="core-glow">
            <stop offset="0%" stopColor="#1f6feb" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#1f6feb" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="spoke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#1f6feb" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#7c4dff" stopOpacity="0.07" />
          </linearGradient>
        </defs>

        {/* guide rings */}
        <circle cx={C} cy={C} r={OUTER_R} className="ring" />
        <circle cx={C} cy={C} r={INNER_R} className="ring" />
        <circle cx={C} cy={C} r={62} className="ring faint" />

        {/* spokes + travelling pulses */}
        {nodes.map((n) => (
          <g key={`spoke-${n.pkg}`}>
            <line x1={C} y1={C} x2={n.x} y2={n.y} stroke="url(#spoke)" strokeWidth="1" />
            <line
              x1={C}
              y1={C}
              x2={n.x}
              y2={n.y}
              className="pulse"
              style={{
                animationDelay: `${(n.i % 9) * 0.5 + (n.i % 3) * 0.17}s`,
                // the dash has to span each ring's own length
                strokeDasharray: `14 ${n.r}`,
                strokeDashoffset: n.r + 14,
                ['--spoke-len' as string]: `${n.r + 14}`,
              }}
            />
          </g>
        ))}

        {/* channel nodes */}
        {nodes.map((n) => (
          <g key={n.pkg} className="node" style={{ animationDelay: `${(n.i % 7) * 0.4}s` }}>
            <circle cx={n.x} cy={n.y} r={NODE_R} className="node-bg" />
            <g transform={`translate(${n.x - 10} ${n.y - 10}) scale(0.833)`}>{markGlyph(n.pkg)}</g>
          </g>
        ))}

        {/* the hub */}
        <circle cx={C} cy={C} r="92" fill="url(#core-glow)" className="core-glow" />
        <circle cx={C} cy={C} r="44" className="core" />
        <text x={C} y={C + 5} textAnchor="middle" className="core-text">
          msgly
        </text>
      </svg>
    </div>
  );
}
