import { channels } from '../data';
import { markGlyph } from './BrandMark';

const C = 220; // centre
const INNER_R = 122;
const OUTER_R = 194;
const NODE_R = 19;

/**
 * Seconds for one full turn of each ring. They differ, and turn opposite ways,
 * so the two rings drift past each other instead of moving as one rigid disc.
 * Slow on purpose: this sits behind the headline and should never pull the eye
 * away from it.
 */
const INNER_TURN = 72;
const OUTER_TURN = 96;

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

function Spoke({ n }: { n: Node }) {
  return (
    <g>
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
  );
}

/**
 * A channel node.
 *
 * The glyph is wrapped in its own counter-rotating group: the ring carries the
 * node around the circle, and this turns it back by exactly as much, so a logo
 * orbits without ever going upside down. `--turn` and the direction have to
 * mirror the parent ring's, which is why both come from the same constants.
 */
function OrbitNode({ n, turn, reverse }: { n: Node; turn: number; reverse: boolean }) {
  return (
    <g className="node" style={{ animationDelay: `${(n.i % 7) * 0.4}s` }}>
      <g
        className={reverse ? 'node-upright reverse' : 'node-upright'}
        style={{
          transformOrigin: `${n.x}px ${n.y}px`,
          ['--turn' as string]: `${turn}s`,
        }}
      >
        <circle cx={n.x} cy={n.y} r={NODE_R} className="node-bg" />
        <g transform={`translate(${n.x - 10} ${n.y - 10}) scale(0.833)`}>{markGlyph(n.pkg)}</g>
      </g>
    </g>
  );
}

/** One hub, every channel — two counter-rotating rings, pulses travelling out. */
export default function HeroOrbit() {
  const innerNodes = place(inner, INNER_R, 0, 0);
  const outerNodes = place(outer, OUTER_R, 0.5, inner.length);

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

        {/* guide rings — the dashed one drifts, which reads as motion even
            where the nodes happen to be sparse */}
        <circle cx={C} cy={C} r={OUTER_R} className="ring" />
        <circle cx={C} cy={C} r={INNER_R} className="ring" />
        <circle cx={C} cy={C} r={62} className="ring faint drift" />

        {/* Each ring turns as one piece, spokes and nodes together, so a spoke
            never drifts off the node it points at. */}
        <g className="ring-spin" style={{ ['--turn' as string]: `${INNER_TURN}s` }}>
          {innerNodes.map((n) => (
            <Spoke key={`spoke-${n.pkg}`} n={n} />
          ))}
          {innerNodes.map((n) => (
            <OrbitNode key={n.pkg} n={n} turn={INNER_TURN} reverse={false} />
          ))}
        </g>

        <g className="ring-spin reverse" style={{ ['--turn' as string]: `${OUTER_TURN}s` }}>
          {outerNodes.map((n) => (
            <Spoke key={`spoke-${n.pkg}`} n={n} />
          ))}
          {outerNodes.map((n) => (
            <OrbitNode key={n.pkg} n={n} turn={OUTER_TURN} reverse />
          ))}
        </g>

        {/* the hub — deliberately still, so the rotation has something to
            rotate around */}
        <circle cx={C} cy={C} r="92" fill="url(#core-glow)" className="core-glow" />
        <circle cx={C} cy={C} r="44" className="core" />
        <text x={C} y={C + 5} textAnchor="middle" className="core-text">
          msgly
        </text>
      </svg>
    </div>
  );
}
