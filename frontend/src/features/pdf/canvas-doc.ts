import { A4, buildPdf, type PdfPage } from './pdf';

/** A4 캔버스 페이지에 리포트를 그리는 공용 도구. 각 페이지는 JPEG로 PDF에 담긴다. */
export const SCALE = 2; // 1pt = 2px → 약 144dpi
export const MARGIN = 40;
export const CONTENT_W = A4.width - MARGIN * 2;
export const FOOTER_Y = A4.height - 28;

export const color = {
  ink: '#002162',
  primary: '#346db3',
  muted: '#6b7280',
  faint: '#9ca3af',
  line: '#d2d4d6',
  soft: '#f4f5f5',
  tint: '#e4effe',
  normal: '#22c55e',
  caution: '#f59e0b',
  high: '#ef4444',
  unknown: '#c4c8cd',
};

function fontFamily() {
  return getComputedStyle(document.documentElement).fontFamily || 'sans-serif';
}

export class Pages {
  readonly canvases: HTMLCanvasElement[] = [];
  ctx!: CanvasRenderingContext2D;
  y = 0;
  private readonly family = fontFamily();
  constructor(private readonly title: string) {
    this.add();
  }
  add() {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(A4.width * SCALE);
    canvas.height = Math.round(A4.height * SCALE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('캔버스를 사용할 수 없습니다.');
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, A4.width, A4.height);
    ctx.textBaseline = 'alphabetic';
    this.canvases.push(canvas);
    this.ctx = ctx;
    this.y = MARGIN;
    this.pageHeader();
  }
  /** 남은 공간이 부족하면 새 페이지. 새 페이지가 생기면 true. */
  ensure(height: number) {
    if (this.y + height <= FOOTER_Y - 16) return false;
    this.add();
    return true;
  }
  font(size: number, weight = 400) {
    this.ctx.font = `${weight} ${size}px ${this.family}`;
  }
  text(
    value: string,
    x: number,
    y: number,
    size: number,
    fill: string,
    weight = 400,
    align: CanvasTextAlign = 'left',
  ) {
    this.font(size, weight);
    this.ctx.fillStyle = fill;
    this.ctx.textAlign = align;
    this.ctx.fillText(value, x, y);
  }
  rect(x: number, y: number, w: number, h: number, fill: string, radius = 0) {
    this.ctx.fillStyle = fill;
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, w, h, radius);
    this.ctx.fill();
  }
  strokeRect(x: number, y: number, w: number, h: number, stroke: string, radius = 0) {
    this.ctx.strokeStyle = stroke;
    this.ctx.lineWidth = 0.75;
    this.ctx.beginPath();
    this.ctx.roundRect(x, y, w, h, radius);
    this.ctx.stroke();
  }
  hline(y: number, stroke = color.line, width = 0.75) {
    this.ctx.strokeStyle = stroke;
    this.ctx.lineWidth = width;
    this.ctx.beginPath();
    this.ctx.moveTo(MARGIN, y);
    this.ctx.lineTo(MARGIN + CONTENT_W, y);
    this.ctx.stroke();
  }
  private pageHeader() {
    this.text('ECOLEPHANT', MARGIN, this.y + 10, 10, color.ink, 800);
    this.text(this.title, MARGIN + 74, this.y + 10, 10, color.muted, 500);
    this.text(
      `${new Date().toLocaleString('ko-KR')} 출력`,
      MARGIN + CONTENT_W,
      this.y + 10,
      8,
      color.faint,
      400,
      'right',
    );
    this.hline(this.y + 18, color.primary, 1.5);
    this.y += 38;
  }
  footers(disclaimer: string) {
    const total = this.canvases.length;
    this.canvases.forEach((canvas, index) => {
      const ctx = canvas.getContext('2d')!;
      this.ctx = ctx;
      if (index === total - 1) this.text(disclaimer, MARGIN, FOOTER_Y, 8, color.faint);
      this.text(
        `${index + 1} / ${total}`,
        MARGIN + CONTENT_W,
        FOOTER_Y,
        8,
        color.faint,
        400,
        'right',
      );
    });
  }
}

export function sectionTitle(doc: Pages, title: string) {
  doc.ensure(40);
  doc.text(title, MARGIN, doc.y + 12, 13, color.ink, 700);
  doc.y += 24;
}

export function chip(doc: Pages, label: string, x: number, y: number, fill: string, ink: string) {
  doc.font(9, 600);
  const w = doc.ctx.measureText(label).width + 14;
  doc.rect(x, y - 11, w, 16, fill, 8);
  doc.text(label, x + 7, y + 1, 9, ink, 600);
  return w;
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<PdfPage> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.92),
  );
  if (!blob) throw new Error('PDF 페이지를 만들지 못했습니다.');
  return {
    jpeg: new Uint8Array(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  };
}

export const DISCLAIMER = '자세 습관을 돌아보기 위한 참고 자료이며, 의료 진단을 대신하지 않아요.';

export async function startDocument(title: string) {
  await document.fonts?.ready;
  return new Pages(title);
}

export async function finishDocument(doc: Pages): Promise<Blob> {
  doc.footers(DISCLAIMER);
  const pages: PdfPage[] = [];
  for (const canvas of doc.canvases) pages.push(await toJpeg(canvas));
  return buildPdf(pages);
}
