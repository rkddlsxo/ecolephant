/**
 * 의존성 없는 최소 PDF 작성기.
 * 각 페이지를 JPEG 이미지 한 장으로 담는다 (DCTDecode). 한글은 브라우저가 캔버스에 그린 그대로 들어간다.
 */
export type PdfPage = { jpeg: Uint8Array; width: number; height: number };

export const A4 = { width: 595.28, height: 841.89 } as const;

export function buildPdf(pages: PdfPage[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: () => void) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body();
    push('\nendobj\n');
  };

  // 1: 카탈로그, 2: 페이지 트리, 이후 페이지마다 [페이지, 내용, 이미지] 3개
  const pageId = (i: number) => 3 + i * 3;
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () =>
    push(
      `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    ),
  );
  pages.forEach((page, i) => {
    const id = pageId(i);
    const content = `q ${A4.width} 0 0 ${A4.height} 0 0 cm /Im0 Do Q`;
    object(id, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
      ),
    );
    object(id + 1, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    object(id + 2, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      );
      push(page.jpeg);
      push('\nendstream');
    });
  });

  const size = 3 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id += 1) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}
