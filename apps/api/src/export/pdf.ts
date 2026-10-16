import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { renderMathPlain } from '@linguaflow/shared';
import { config } from '../config.js';
import { buildMeetingMarkdown, type MeetingDocument } from './meeting.js';

function readableMath(markdown: string) {
  return markdown.replace(/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g, (_whole, block: string | undefined, inline: string | undefined) => {
    const rendered = renderMathPlain((block ?? inline ?? '').trim());
    return rendered.ok ? rendered.text : `${rendered.text}（公式未完整排版）`;
  });
}

export function resolvePdfFont() {
  const candidates = [config.pdfFontPath, '/usr/share/fonts/linguaflow/NotoSansCJKsc-Regular.otf'].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function renderMeetingPdf(doc: MeetingDocument, fontPath: string, scope: 'summary' | 'full') {
  const pdf = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true, info: { Title: doc.title } });
  const chunks: Buffer[] = [];
  pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
  });
  pdf.font(fontPath);
  const markdown = readableMath(buildMeetingMarkdown(doc, scope));
  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (!line.trim()) { pdf.moveDown(0.35); continue; }
    if (heading) {
      const size = heading[1].length === 1 ? 18 : 13;
      pdf.moveDown(0.3).fontSize(size).text(heading[2] ?? '');
      continue;
    }
    pdf.fontSize(11).text(line, { lineGap: 2 });
  }
  const range = pdf.bufferedPageRange();
  for (let index = 0; index < range.count; index += 1) {
    pdf.switchToPage(index);
    pdf.fontSize(9).text(`${index + 1} / ${range.count}`, 54, pdf.page.height - 36, { align: 'center', width: pdf.page.width - 108, lineBreak: false });
  }
  pdf.end();
  return done;
}
