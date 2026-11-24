import { ChangeSet, Text } from '@codemirror/state';

const sourceText = text => Text.of(text.split('\n'));
const sameWriter = (a, b) => a === b || (a && b && a.id === b.id && a.name === b.name && a.color === b.color);

// Indexed by logical source line, never by rendered Fountain rows or wraps.
// In SQLite, repeated writers (including unknown) are stored as runs.
export class LineBlame {
  constructor(text, runs) { this.reset(text, runs); }

  reset(text, runs) {
    this.source = sourceText(text);
    this.writers = Array(this.source.lines).fill(null);
    let from = 0;
    for (const [length, writer] of runs || []) {
      this.writers.fill(writer, from, from + length);
      from += length;
    }
    if (from && from !== this.writers.length) this.writers.fill(null);
  }

  runs() {
    const runs = [];
    for (const writer of this.writers) {
      const last = runs.at(-1);
      if (last && sameWriter(last[1], writer)) last[0]++;
      else runs.push([1, writer]);
    }
    return runs;
  }

  update(ytext, delta, evidence) {
    if (evidence?.restore) { this.reset(ytext.toString(), evidence.restore); return; }
    const edits = [];
    let pos = 0;
    for (const op of delta) {
      if (op.retain) pos += op.retain;
      else if (op.delete) { edits.push({ from: pos, to: pos + op.delete }); pos += op.delete; }
      else if (typeof op.insert === 'string') edits.push({ from: pos, insert: sourceText(op.insert) });
      else if (op.insert !== undefined) { this.reset(ytext.toString()); return; }
    }
    // Y.Text can contain embeds, which are invisible to toString(). Never
    // guess at provenance if the CRDT offsets no longer describe plain text.
    if (pos > this.source.length) { this.reset(ytext.toString()); return; }
    if (!edits.length) return;
    const before = this.source;
    const changes = ChangeSet.of(edits, before.length);
    const after = changes.apply(before);
    if (after.length !== ytext.length) { this.reset(ytext.toString()); return; }
    const windows = [];
    changes.iterChanges((fromA, toA, fromB, toB) => {
      const first = before.lineAt(fromA).number, last = before.lineAt(toA).number;
      const start = after.lineAt(fromB).number, end = after.lineAt(toB).number;
      const prev = windows.at(-1);
      if (prev && (first <= prev.last || start <= prev.end)) {
        prev.last = last; prev.end = end;
      } else windows.push({ first, last, start, end });
    });
    for (const { first, last, start, end } of windows.reverse()) {
      if (last - first === end - start &&
          before.sliceString(before.line(first).from, before.line(last).to) ===
          after.sliceString(after.line(start).from, after.line(end).to)) continue;
      const writers = Array(end - start + 1).fill(evidence?.writer ?? null);
      const kept = new Set();
      for (let n = first; n <= last; n++) {
        const old = before.line(n);
        // Start follows text inserted before it, end stays before text
        // appended to it. A complete line shifted by an insertion/deletion
        // retains its writer; split or joined content gets the new writer.
        const from = changes.mapPos(old.from, 1), to = changes.mapPos(old.to, -1);
        const candidates = old.length ? [from] : [from, to];
        for (const offset of candidates) {
          const line = after.lineAt(offset);
          if (line.number < start || line.number > end || kept.has(line.number) ||
              offset !== line.from || (old.length && to !== line.to) || line.text !== old.text) continue;
          writers[line.number - start] = this.writers[n - 1];
          kept.add(line.number);
          break;
        }
      }
      const index = first - 1;
      if (last - first === end - start) {
        for (let i = 0; i < writers.length; i++) this.writers[index + i] = writers[i];
      } else {
        // No spreading a potentially multi-megabyte paste into splice().
        this.writers = this.writers.slice(0, index).concat(writers, this.writers.slice(last));
      }
    }
    this.source = after;
  }
}
