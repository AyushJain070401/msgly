'use client';

import { useState, Fragment } from 'react';

const TOKEN =
  /(\/\/[^\n]*)|(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|\b(const|let|await|async|import|from|function|return|new|if|else|for|of|export|true|false)\b|\b([A-Za-z_$][\w$]*)(?=\()|\b(\d[\d_]*)\b/g;

const CLASS: Record<number, string> = { 1: 'c', 2: 's', 3: 'k', 4: 'f', 5: 'n' };

function highlight(code: string) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;

  while ((m = TOKEN.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const group = [1, 2, 3, 4, 5].find((g) => m![g] !== undefined)!;
    out.push(
      <span key={m.index} className={CLASS[group]}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));

  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

export default function CodeBlock({ code, file }: { code: string; file?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — leave the button alone */
    }
  }

  return (
    <div className="code">
      <div className="code-bar">
        <i className="lamp" />
        <i className="lamp" />
        <i className="lamp" />
        {file ? <span className="code-file">{file}</span> : null}
        <button className="copy" data-done={copied} onClick={copy} type="button">
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre>
        <code>{highlight(code)}</code>
      </pre>
    </div>
  );
}
