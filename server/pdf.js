import PDFDocument from 'pdfkit';
import { parseFountain, plainText, inlineFountain } from '../shared/fountain.js';

const TOP = 54, BOTTOM = 738, LINE = 12;
const fontFor = run => `Courier${run.bold && run.italic ? '-BoldOblique' : run.bold ? '-Bold' : run.italic ? '-Oblique' : ''}`;

// Use the shared parser's restricted emphasis grammar, not an HTML renderer.
// Literal HTML is escaped by inlineFountain and becomes ordinary PDF text.
function runsFor(text, bold = false) {
  const runs = [];
  const style = { bold: bold ? 1 : 0, italic: 0, underline: 0 };
  for (const part of inlineFountain(text).split(/(<\/?(?:strong|em|u)>)/)) {
    const tag = /^<(\/?)(strong|em|u)>$/.exec(part);
    if (tag) style[{ strong: 'bold', em: 'italic', u: 'underline' }[tag[2]]] += tag[1] ? -1 : 1;
    else if (part) runs.push({ bold: style.bold > 0, italic: style.italic > 0, underline: style.underline > 0, text: part.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity])) });
  }
  return runs;
}

function wrappedLines(pdf, text, width, bold = false) {
  const lines = [[]];
  let used = 0;
  const nextLine = () => { lines.push([]); used = 0; };
  for (const run of runsFor(text, bold)) {
    pdf.font(fontFor(run));
    for (const token of run.text.match(/\n|[^\S\n]+|[^\s]+/g) || []) {
      if (token === '\n') { nextLine(); continue; }
      const size = pdf.widthOfString(token);
      if (used && used + size > width) nextLine();
      // Fountain action can contain long URLs or other unbroken words.
      for (const char of token) {
        const charWidth = pdf.widthOfString(char);
        if (used && used + charWidth > width) nextLine();
        const line = lines.at(-1), last = line.at(-1);
        if (last && last.font === fontFor(run) && last.underline === run.underline) last.text += char;
        else line.push({ text: char, font: fontFor(run), underline: run.underline });
        used += charWidth;
      }
    }
  }
  return lines;
}

function drawLine(pdf, runs, x, y, width, align = 'left') {
  let lineWidth = 0;
  for (const run of runs) { pdf.font(run.font); lineWidth += pdf.widthOfString(run.text); }
  let cursor = x + (align === 'center' ? (width - lineWidth) / 2 : align === 'right' ? width - lineWidth : 0);
  for (const run of runs) {
    pdf.font(run.font).text(run.text, cursor, y, { lineBreak: false, underline: run.underline });
    cursor += pdf.widthOfString(run.text);
  }
}

function titleFields(blocks) {
  const fields = {};
  let key;
  for (const line of blocks.filter(block => block.type === 'title').flatMap(block => block.text.split('\n'))) {
    const match = /^([\w ]+):\s*(.*)$/.exec(line);
    if (match) { key = match[1].toLowerCase(); fields[key] = match[2]; }
    else if (key) fields[key] += `\n${line.trim()}`;
  }
  return fields;
}

// Exported separately so layout can be tested without scraping compressed PDFs.
export function writeScreenplay(pdf, text, title) {
  const blocks = parseFountain(text);
  const fields = titleFields(blocks);
  const lastTitle = blocks.findLastIndex(block => block.type === 'title');
  pdf.fontSize(12).font('Courier');
  const titleArea = (value, x, y, width, align = 'center', maxLines = 8) => {
    if (!value) return;
    for (const [index, line] of wrappedLines(pdf, value, width).slice(0, maxLines).entries()) drawLine(pdf, line, x, y + index * LINE, width, align);
  };
  titleArea(fields.title || title || 'Untitled screenplay', 108, 228, 432, 'center', 5);
  titleArea(fields.credit || ((fields.author || fields.authors) ? 'Written by' : ''), 108, 300, 432, 'center', 2);
  titleArea(fields.author || fields.authors, 108, 336, 432, 'center', 4);
  titleArea(fields.source, 108, 408, 432, 'center', 6);
  titleArea(fields.contact, 108, 636, 270, 'left', 6);
  titleArea([fields['draft date'], fields.copyright].filter(Boolean).join('\n'), 378, 660, 162, 'right', 4);
  pdf.addPage();
  let y = TOP;
  const newPage = () => { pdf.addPage(); y = TOP; };
  const renderRows = (left, right = null) => {
    for (let i = 0; i < Math.max(left.length, right?.length || 0); i++) {
      if (y + LINE > BOTTOM) newPage();
      for (const row of [left[i], right?.[i]]) if (row) drawLine(pdf, row.line, row.x, y, row.width, row.align);
      y += LINE;
    }
  };
  const rows = (block, column) => {
    const layout = column
      ? { x: column.x + (block.type === 'parenthetical' ? 12 : 0), width: column.width - (block.type === 'parenthetical' ? 24 : 0), align: block.type === 'character' ? 'center' : 'left' }
      : ({
          character: { x: 252, width: 216 },
          dialogue: { x: 180, width: 252 },
          parenthetical: { x: 216, width: 180 },
          transition: { x: 108, width: 432, align: 'right' },
          centered: { x: 108, width: 432, align: 'center' },
        }[block.type] || { x: 108, width: 432 });
    return wrappedLines(pdf, block.text, layout.width, block.type === 'character').map(line => ({ ...layout, line }));
  };
  const groupEnd = start => {
    let end = start + 1;
    while (end < blocks.length && ['dialogue', 'parenthetical'].includes(blocks[end].type)) end++;
    return end;
  };
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (['title', 'section', 'synopsis', 'note', 'boneyard'].includes(block.type)) continue;
    if (block.type === 'pagebreak') { newPage(); continue; }
    if (block.type === 'blank') {
      // No synthetic spacing: each Fountain blank line takes exactly one line.
      // The title separator does not add a blank line at the top of page one.
      if (lastTitle >= 0 && i === lastTitle + 1) continue;
      if (y + LINE > BOTTOM) newPage();
      y += LINE;
      continue;
    }
    if (block.type === 'character') {
      const end = groupEnd(i);
      let next = end;
      while (blocks[next]?.type === 'blank') next++;
      if (blocks[next]?.type === 'character' && blocks[next].dual) {
        const rightEnd = groupEnd(next);
        const leftRows = blocks.slice(i, end).flatMap(part => rows(part, { x: 108, width: 198 }));
        const rightRows = blocks.slice(next, rightEnd).flatMap(part => rows(part, { x: 342, width: 198 }));
        // Keep ordinary dual exchanges together; longer ones paginate both
        // columns in lockstep rather than overlapping or losing a column.
        const height = Math.max(leftRows.length, rightRows.length) * LINE;
        if (height <= BOTTOM - TOP && y + height > BOTTOM) newPage();
        renderRows(leftRows, rightRows);
        i = rightEnd - 1;
        continue;
      }
      const dialogueRows = blocks.slice(i, end).flatMap(part => rows(part));
      if (y + Math.min(dialogueRows.length, 3) * LINE > BOTTOM) newPage();
      renderRows(dialogueRows);
      i = end - 1;
      continue;
    }
    renderRows(rows(block));
  }
  // Title page and first screenplay page are unnumbered. Script page two is 2.
  const range = pdf.bufferedPageRange();
  for (let n = range.start + 2; n < range.start + range.count; n++) {
    pdf.switchToPage(n);
    pdf.font('Courier').text(`${n}.`, 500, 30, { width: 40, lineBreak: false, align: 'right' });
  }
}

export function renderPDF(text, title, response) {
  const pdf = new PDFDocument({ size: 'LETTER', margins: { top: TOP, bottom: 54, left: 108, right: 72 }, bufferPages: true, info: { Title: plainText(title || 'Untitled screenplay') } });
  pdf.pipe(response);
  writeScreenplay(pdf, text, title);
  pdf.end();
}
