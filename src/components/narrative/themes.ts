/**
 * 叙事工坊 · 金句卡主题与 SVG/PNG 导出
 * 从旧 public/narrative.html 逐字移植（渲染参数保持一致）。
 */

export type CardTheme = { name: string; bg: string; text: string; sub: string; accent: string };

export const CARD_THEMES: Record<string, CardTheme> = {
  paper:  { name: '米白纸张', bg: '#FAF6EF', text: '#26221C', sub: '#8B8378', accent: '#C9A063' },
  coffee: { name: '咖啡暖棕', bg: '#F3E9DC', text: '#4A3423', sub: '#93765C', accent: '#9C6B3F' },
  night:  { name: '深夜蓝黑', bg: '#1B2432', text: '#F2F3F5', sub: '#8A93A6', accent: '#8FA8D8' }
};

function escXml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* 按字符数贪心换行（中文按 1 字宽） */
function wrapQuote(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text.replace(/\s+/g, '')) {
    cur += ch;
    if (cur.length >= perLine) { lines.push(cur); cur = ''; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/* 字号与每行字数随内容量自适应 */
function quoteFontSpec(len: number): { size: number; perLine: number } {
  if (len <= 10) return { size: 76, perLine: 8 };
  if (len <= 16) return { size: 66, perLine: 10 };
  if (len <= 24) return { size: 56, perLine: 12 };
  if (len <= 36) return { size: 48, perLine: 14 };
  return { size: 40, perLine: 16 };
}

export function buildCardSVG(quote: string, sign: string, themeKey: string): string {
  const t = CARD_THEMES[themeKey] || CARD_THEMES.paper;
  const W = 1080, H = 1440;
  let q = (quote || '').trim();
  if (q.length > 80) q = q.slice(0, 79) + '…';
  const spec = quoteFontSpec(q.length);
  const lines = wrapQuote(q, spec.perLine);
  const lh = Math.round(spec.size * 1.75);
  const blockH = lines.length * lh;
  const startY = 640 - blockH / 2 + spec.size;   // 金句块垂直居中于卡面上半部

  const quoteLines = lines.map((l, i) =>
    '<text x="540" y="' + (startY + i * lh) + '" text-anchor="middle" font-size="' + spec.size
    + '" font-weight="600" fill="' + t.text + '">' + escXml(l) + '</text>'
  ).join('\n    ');

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">\n'
    + '  <rect width="' + W + '" height="' + H + '" fill="' + t.bg + '"/>\n'
    + '  <text x="90" y="118" font-size="26" letter-spacing="8" fill="' + t.sub + '" font-family="-apple-system,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">闭着眼睛整点薯条</text>\n'
    + '  <text x="72" y="500" font-size="260" font-family="Georgia,\'Songti SC\',serif" fill="' + t.accent + '" opacity="0.85">“</text>\n'
    + '  <g font-family="-apple-system,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">\n    '
    + quoteLines + '\n  </g>\n'
    + '  <rect x="440" y="1120" width="200" height="3" fill="' + t.accent + '"/>\n'
    + '  <text x="540" y="1200" text-anchor="middle" font-size="34" font-weight="500" fill="' + t.text + '" font-family="-apple-system,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">' + escXml(sign || '') + '</text>\n'
    + '  <text x="540" y="1260" text-anchor="middle" font-size="22" letter-spacing="4" fill="' + t.sub + '" font-family="-apple-system,\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif">个人成长 · 创业记录 · 开店实录</text>\n'
    + '</svg>';
}

/* ---------- 下载（旧页 downloadCardSVG / downloadCardPNG） ---------- */

export function downloadCardSVG(svg: string, onDone: (msg: string, isError?: boolean) => void): void {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '金句卡.svg';
  a.click();
  URL.revokeObjectURL(url);
  onDone('已下载 金句卡.svg');
}

/** canvas 2x 导出：2160×2880 */
export function downloadCardPNG(svg: string, onDone: (msg: string, isError?: boolean) => void): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = function () {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = 1080 * scale;
    canvas.height = 1440 * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) { URL.revokeObjectURL(url); onDone('PNG 导出失败，请改用下载 SVG', true); return; }
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, 1080, 1440);
    URL.revokeObjectURL(url);
    canvas.toBlob(function (b) {
      if (!b) { onDone('PNG 导出失败，请改用下载 SVG', true); return; }
      const u = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = u;
      a.download = '金句卡.png';
      a.click();
      URL.revokeObjectURL(u);
      onDone('已下载 金句卡.png（2160×2880）');
    }, 'image/png');
  };
  img.onerror = function () {
    URL.revokeObjectURL(url);
    onDone('PNG 导出失败，请改用下载 SVG', true);
  };
  img.src = url;
}
