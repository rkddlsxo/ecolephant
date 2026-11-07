import { expect, test } from 'vitest';
import { buildPdf } from './pdf';

function readBytes(blob: Blob) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

test('writes one page object and one JPEG image per page with a valid xref table', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const blob = buildPdf([
    { jpeg, width: 10, height: 20 },
    { jpeg, width: 10, height: 20 },
  ]);
  expect(blob.type).toBe('application/pdf');
  const bytes = await readBytes(blob);
  const body = new TextDecoder('latin1').decode(bytes);
  expect(body.startsWith('%PDF-1.4')).toBe(true);
  expect(body.trimEnd().endsWith('%%EOF')).toBe(true);
  expect(body).toContain('/Count 2');
  expect(body.match(/\/Type \/Page /g)).toHaveLength(2);
  expect(body.match(/\/Filter \/DCTDecode/g)).toHaveLength(2);

  // xref 오프셋이 실제 객체 위치를 가리키는지 확인
  const startxref = Number(/startxref\n(\d+)/.exec(body)![1]);
  const xref = new TextDecoder('latin1').decode(bytes.slice(startxref));
  const entries = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  expect(entries).toHaveLength(8);
  entries.forEach((offset, index) => {
    const head = new TextDecoder('latin1').decode(bytes.slice(offset, offset + 12));
    expect(head.startsWith(`${index + 1} 0 obj`)).toBe(true);
  });
});
