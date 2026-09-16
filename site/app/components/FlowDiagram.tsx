/**
 * The architecture stack drawn as a flow: one outbound lane and one inbound
 * lane, with a packet travelling each. The layer list below says what the
 * pieces are; this says what actually moves between them, in both directions.
 */
const NODE_W = 140;
const BOX_Y = 52;
const BOX_H = 112;
const OUT_Y = 126;
const IN_Y = 148;
const W = 928;
const H = 212;

const NODES = [
  { x: 14, label: 'Your app', sub: 'Express · worker', own: 'you' },
  { x: 204, label: '@msgly/core', sub: 'hub · retries', own: 'msgly' },
  { x: 394, label: 'Adapter', sub: 'one package', own: 'msgly' },
  { x: 584, label: 'Platform API', sub: 'Telegram · Twilio', own: 'platform' },
  { x: 774, label: 'Customer', sub: 'phone · inbox', own: 'platform' },
];

const FIRST_EXIT = NODES[0]!.x + NODE_W;
const LAST_ENTRY = NODES[NODES.length - 1]!.x;

export default function FlowDiagram() {
  return (
    <div className="flow-scroll">
      <svg
        className="flow-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="A message leaves your app, passes through msgly core and a channel adapter to the platform API and on to the customer. Replies travel back along the same path and arrive as webhooks."
        style={
          {
            '--flow-from': `${FIRST_EXIT}px`,
            '--flow-to': `${LAST_ENTRY}px`,
          } as React.CSSProperties
        }
      >
        {NODES.slice(0, -1).map((n, i) => {
          const x1 = n.x + NODE_W;
          const x2 = NODES[i + 1]!.x;
          return (
            <g key={`lane-${i}`}>
              <line className="flow-lane" x1={x1} y1={OUT_Y} x2={x2 - 8} y2={OUT_Y} />
              <path
                className="flow-tip"
                d={`M${x2 - 9} ${OUT_Y - 4.5} L${x2 - 2} ${OUT_Y} L${x2 - 9} ${OUT_Y + 4.5}`}
              />
              <line className="flow-lane" x1={x1 + 8} y1={IN_Y} x2={x2} y2={IN_Y} />
              <path
                className="flow-tip"
                d={`M${x1 + 9} ${IN_Y - 4.5} L${x1 + 2} ${IN_Y} L${x1 + 9} ${IN_Y + 4.5}`}
              />
            </g>
          );
        })}

        <circle className="flow-packet out" r="4.5" cy={OUT_Y} />
        <circle className="flow-packet in" r="4.5" cy={IN_Y} />

        {NODES.map((n) => (
          <g key={n.label} className="flow-node" data-own={n.own}>
            <rect x={n.x} y={BOX_Y} width={NODE_W} height={BOX_H} rx="14" />
            <text className="flow-title" x={n.x + NODE_W / 2} y={BOX_Y + 34}>
              {n.label}
            </text>
            <text className="flow-sub" x={n.x + NODE_W / 2} y={BOX_Y + 54}>
              {n.sub}
            </text>
          </g>
        ))}

        <text className="flow-lane-label" x={W / 2} y={30}>
          send() — outbound
        </text>
        <text className="flow-lane-label" x={W / 2} y={196}>
          handleWebhook() — inbound
        </text>
      </svg>
    </div>
  );
}
