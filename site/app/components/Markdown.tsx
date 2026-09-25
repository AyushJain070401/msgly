import { Fragment, type ReactNode } from 'react';

/**
 * Renders the small markdown subset that changeset bodies actually use:
 * paragraphs, bullet lists, fenced code blocks, `inline code`, **bold**,
 * _italics_ and [links](url).
 *
 * This is deliberately not a markdown library. The input is our own release
 * notes, not user content, and pulling a parser in for six constructs would
 * cost more bundle than the whole changelog page.
 */

// Ordered so code wins: a backtick span is literal and must not be re-parsed
// for the emphasis markers it may legitimately contain.
const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    const key = `${keyPrefix}-${i}`;

    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    // Bold and italic recurse: "**`reactions` was ...**" has to render the
    // code span inside the bold rather than printing the backticks.
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{inline(part.slice(2, -2), key)}</strong>;
    }
    if (part.startsWith('_') && part.endsWith('_') && part.length > 2) {
      return <em key={key}>{inline(part.slice(1, -1), key)}</em>;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

/** Plain text of a markdown span, for comparing against a stripped headline. */
function strip(md: string): string {
  return md
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

type Segment = { kind: 'prose'; text: string } | { kind: 'code'; text: string };

/**
 * Split a body into prose and fenced-code segments.
 *
 * Code has to be lifted out before anything else touches the text: inside a
 * fence, blank lines and leading spaces are content, and the paragraph split
 * that prose goes through would shred them.
 */
function segment(body: string): Segment[] {
  const out: Segment[] = [];
  const fence = /^```[^\n]*\n([\s\S]*?)\n?^```[ \t]*$/gm;
  let cursor = 0;

  for (const m of body.matchAll(fence)) {
    const at = m.index ?? 0;
    const before = body.slice(cursor, at);
    if (before.trim()) out.push({ kind: 'prose', text: before });
    out.push({ kind: 'code', text: m[1] });
    cursor = at + m[0].length;
  }

  const rest = body.slice(cursor);
  if (rest.trim() || out.length === 0) out.push({ kind: 'prose', text: rest });
  return out;
}

export default function Markdown({
  body,
  /**
   * When the caller already shows the note's first sentence as a heading,
   * repeating it as the opening paragraph reads like a stutter. Pass it here
   * and the leading block is dropped if it is that same sentence.
   */
  skipHeadline,
}: {
  body: string;
  skipHeadline?: string;
}) {
  const segments = segment(body);
  let headlinePending = Boolean(skipHeadline);

  return (
    <>
      {segments.map((seg, si) => {
        if (seg.kind === 'code') {
          return (
            <pre key={si} className="md-code">
              <code>{seg.text}</code>
            </pre>
          );
        }

        // Changeset bodies are hard-wrapped at ~80 columns. Joining the lines
        // inside a block lets the browser re-wrap to the reader's width
        // instead of keeping the author's line breaks.
        let blocks = seg.text.split(/\n\s*\n/).filter((b) => b.trim());

        // Only the first prose segment can open with the headline. Dropping it
        // needs something else left to show, or a one-paragraph note would
        // render as nothing at all.
        if (headlinePending && (blocks.length > 1 || segments.length > 1)) {
          headlinePending = false;
          const first = strip(blocks[0] ?? '');
          const head = strip(skipHeadline ?? '');
          // The headline is the first *sentence*; the block may be the whole
          // paragraph, so a prefix match is the right test.
          if (first === head || first.startsWith(head)) blocks = blocks.slice(1);
        }

        return (
          <Fragment key={si}>
            {blocks.map((block, bi) => {
              const lines = block.split('\n').map((l) => l.trim());
              const isList = lines.every((l) => l.startsWith('- ') || l.startsWith('  '));

              if (isList && lines[0].startsWith('- ')) {
                // Re-join continuation lines onto their bullet.
                const items: string[] = [];
                for (const line of lines) {
                  if (line.startsWith('- ')) items.push(line.slice(2));
                  else if (items.length) items[items.length - 1] += ` ${line}`;
                }
                return (
                  <ul key={bi} className="md-list">
                    {items.map((item, ii) => (
                      <li key={ii}>{inline(item, `${si}-${bi}-${ii}`)}</li>
                    ))}
                  </ul>
                );
              }

              return <p key={bi}>{inline(lines.join(' '), `${si}-${bi}`)}</p>;
            })}
          </Fragment>
        );
      })}
    </>
  );
}
