import type { NoteImageSpec, CoverSpec, StepsSpec, CodeSpec, ProblemSpec, QuoteSpec, ListSpec, CompareSpec, EndSpec, PhotoSpec, DiagramSpec } from "@contracts/types";

export const THEMES = {
  orange: { bg1: "#fff7ed", bg2: "#ffedd5", accent: "#ea580c", text: "#431407", sub: "#9a3412" },
  blue: { bg1: "#eff6ff", bg2: "#dbeafe", accent: "#2563eb", text: "#172554", sub: "#1e40af" },
  dark: { bg1: "#1c1917", bg2: "#292524", accent: "#fbbf24", text: "#fafaf9", sub: "#d6d3d1" },
  green: { bg1: "#f0fdf4", bg2: "#dcfce7", accent: "#16a34a", text: "#052e16", sub: "#166534" },
} as const;

export type ThemeName = keyof typeof THEMES;

// ============ 文本测宽与自适应排版 ============
// 宽度单位：CJK 字符 = 1，ASCII ≈ 0.55（大写略宽、窄字符略窄）。所有折行/缩字号都基于它

/** 单字符显示宽度（单位宽） */
export function charUnits(ch: string): number {
  if (!/[ -~]/.test(ch)) return 1; // CJK 及全角符号
  if (/[A-Z]/.test(ch)) return 0.66;
  if (/[a-z0-9]/.test(ch)) return 0.56;
  if (/[\s]/.test(ch)) return 0.32;
  return 0.4; // 标点符号
}

/** 整段文本的显示宽度（单位宽） */
export function textUnits(text: string): number {
  let w = 0;
  for (const ch of text) w += charUnits(ch);
  return w;
}

/** 文本在某字号下的像素宽度估算 */
export function textWidthPx(text: string, fontSize: number): number {
  return textUnits(text) * fontSize;
}

/** 不允许出现在行首的标点（悬挂到上一行末尾，允许轻微超出宽度） */
const NO_LINE_START = new Set([..."，。、；：？！）】》」』”’%…—·"]);
/** 不允许停留在行尾的开括号类（挪到下一行开头） */
const NO_LINE_END = new Set([..."（【《「『“‘"]);

/** 带加粗标记的字符（支持 **加粗** 语法） */
export type RichChar = { ch: string; bold: boolean };

/** 折行后的一行富文本；hl 为 Markdown 标题级别（0 无 / 1 大标题 / 2 小标题），pre 为段前间距（px），都挂在行数组上 */
export type RichLine = RichChar[] & { hl?: number; pre?: number };

/** v11 行距/段距用户覆盖（题目卡编辑器可设；contracts 类型由后端补充，前端本地扩展） */
export type ProblemLayoutOverride = {
  lineGap?: number; // 行距倍率，>0 生效，留空自动
  paraGap?: number; // 段距倍率（×行高），默认 1
  fontSize?: number; // 正文字号，留空=自动（14~36 偶数）
};

/** 解析 **加粗** 标记，返回带 bold 标记的字符流（未闭合的 ** 按字面忽略处理）；end 记录解析结束时的加粗状态，供跨行延续 */
export function richChars(text: string, bold?: boolean): RichChar[] & { end: boolean } {
  const out = [] as unknown as RichChar[] & { end: boolean };
  let b = !!bold;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "*" && text[i + 1] === "*") {
      b = !b;
      i++;
      continue;
    }
    out.push({ ch: text[i], bold: b });
  }
  return (out.end = b, out);
}

/** 词感知富文本折行（与 wrapText 同规则：CJK 随意折、ASCII 单词不拆、标点悬挂）；**加粗** 状态跨行延续 */
export function wrapRichText(text: string, maxWidth: number): RichChar[][] {
  let bold = false;
  return wrapText(text, maxWidth).map((line) => {
    const out = richChars(line, bold);
    return (bold = out.end, out);
  });
}

/** 一行富文本字符 → <tspan> 序列（连续同粗细合并） */
export function richCharsToTspans(chars: RichChar[]): string {
  let out = "";
  let bold = false;
  let buf = "";
  const flush = () => {
    if (buf) out += bold ? `<tspan font-weight="700">${esc(buf)}</tspan>` : esc(buf);
    buf = "";
  };
  for (const c of chars) {
    if (c.bold !== bold) {
      flush();
      bold = c.bold;
    }
    buf += c.ch;
  }
  flush();
  return out;
}

/** 分词折行：连续 ASCII 字母数字视为不可拆的词，CJK 逐字，标点悬挂不出现在行首 */
export function wrapText(text: string, maxWidth: number): string[] {
  const chars = [...text.trim()];
  const lines: string[] = [];
  let cur = "";
  let w = 0;
  const pushLine = () => {
    const trimmed = cur.trimEnd();
    if (trimmed) lines.push(trimmed);
    cur = "";
    w = 0;
  };
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    // 空白：行首丢弃，其余占宽度
    if (/\s/.test(ch)) {
      if (!cur) {
        i++;
        continue;
      }
      if (w + charUnits(ch) > maxWidth) {
        pushLine();
      } else {
        cur += ch;
        w += charUnits(ch);
      }
      i++;
      continue;
    }
    // ASCII 单词原子化（不拆词）
    if (/[A-Za-z0-9]/.test(ch)) {
      let j = i;
      while (j < chars.length && /[A-Za-z0-9_]/.test(chars[j])) j++;
      const word = chars.slice(i, j).join("");
      const ww = textUnits(word);
      if (w + ww > maxWidth && cur) {
        if (ww > maxWidth) {
          // 超长单词硬拆
          for (const c of word) {
            const cw = charUnits(c);
            if (w + cw > maxWidth && cur) pushLine();
            cur += c;
            w += cw;
          }
        } else {
          pushLine();
          cur = word;
          w = ww;
        }
      } else {
        cur += word;
        w += ww;
      }
      i = j;
      continue;
    }
    // 单字符（CJK / 标点）
    const cw = charUnits(ch);
    if (w + cw > maxWidth && cur) {
      // 开括号类不停留在行尾：挪到下一行开头
      let moved = "";
      while (cur && NO_LINE_END.has(cur[cur.length - 1])) {
        moved = cur[cur.length - 1] + moved;
        cur = cur.slice(0, -1);
        w -= charUnits(moved[0]);
      }
      pushLine();
      // 标点不出现在行首：连续标点悬挂到上一行末尾（允许轻微超出）
      while (i < chars.length && NO_LINE_START.has(chars[i])) {
        if (lines.length) lines[lines.length - 1] += chars[i];
        i++;
      }
      cur = moved;
      w = textUnits(moved);
      continue;
    }
    cur += ch;
    w += cw;
    i++;
  }
  pushLine();
  return lines;
}

/** 自适应缩字号：从 base 逐步降到 min，直到单行放得下；仍放不下则截断加省略号 */
export function fitText(
  text: string,
  maxWidthPx: number,
  base: number,
  min: number,
): { fontSize: number; text: string } {
  for (let fs = base; fs > min; fs -= 2) {
    if (textWidthPx(text, fs) <= maxWidthPx) return { fontSize: fs, text };
  }
  let cut = text;
  while (cut.length > 1 && textWidthPx(cut + "…", min) > maxWidthPx) cut = cut.slice(0, -1);
  return { fontSize: min, text: cut.length < text.length ? cut + "…" : text };
}

/** 自适应折行：从 base 逐步降到 min，直到折行数 ≤ maxLines；超出截断并在末行加省略号 */
export function fitLines(
  text: string,
  maxWidthPx: number,
  base: number,
  min: number,
  maxLines: number,
): { fontSize: number; lines: string[] } {
  let best: { fontSize: number; lines: string[] } | null = null;
  for (let fs = base; fs > min; fs -= 2) {
    const lines = wrapText(text, maxWidthPx / fs);
    if (lines.length > maxLines) continue;
    if (!best) {
      best = { fontSize: fs, lines };
      continue;
    }
    // 行数更少且字号不低于基准的 70%：优先更紧凑的方案（避免孤字行）
    if (lines.length < best.lines.length && fs >= base * 0.7) {
      best = { fontSize: fs, lines };
    }
  }
  if (best) return best;
  const lines = wrapText(text, maxWidthPx / min);
  if (lines.length <= maxLines) return { fontSize: min, lines };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && textWidthPx(last + "…", min) > maxWidthPx) last = last.slice(0, -1);
  kept[maxLines - 1] = last + "…";
  return { fontSize: min, lines: kept };
}


/** 每张卡片的渐变 id 唯一：多个 SVG 内联在同一页面时，重复的 id 会被第一个元素劫持（串色 bug） */
let gradientSeq = 0;
function nextGradientId(): string {
  return `bg-${++gradientSeq}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderCoverSvg(spec: CoverSpec): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.orange;
  // 标题：900px 内自适应，104px 起逐步缩到 52px，最多 3 行，词感知折行
  const titleFit = fitLines(spec.title, 900, 104, 52, 3);
  const lineH = Math.round(titleFit.fontSize * 1.22);
  const titleY0 = 430;
  const titleSvg = titleFit.lines
    .map(
      (line, i) =>
        `<text x="90" y="${titleY0 + i * lineH}" font-size="${titleFit.fontSize}" font-weight="800" fill="${t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(line)}</text>`,
    )
    .join("");
  // 副标题紧跟标题，自适应最多 2 行
  const subFit = fitLines(spec.subtitle, 900, 42, 26, 2);
  const subY0 = titleY0 + (titleFit.lines.length - 1) * lineH + Math.round(titleFit.fontSize * 0.75);
  const subSvg = subFit.lines
    .map(
      (l, i) =>
        `<text x="90" y="${subY0 + i * Math.round(subFit.fontSize * 1.25)}" font-size="${subFit.fontSize}" fill="${t.sub}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(l)}</text>`,
    )
    .join("");
  // 角标胶囊：fitText 缩字号兜底，宽度封顶 900 防止超长 tag 溢出画布
  const tagFit = fitText(spec.tag, 844, 38, 22);
  const tagW = Math.min(900, Math.max(80, Math.ceil(textWidthPx(tagFit.text, tagFit.fontSize)) + 56));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <circle cx="950" cy="180" r="260" fill="${t.accent}" opacity="0.08"/>
  <circle cx="120" cy="1300" r="320" fill="${t.accent}" opacity="0.06"/>
  <rect x="90" y="120" width="${tagW}" height="72" rx="36" fill="${t.accent}"/>
  <text x="${90 + 28}" y="168" font-size="${tagFit.fontSize}" font-weight="700" fill="#ffffff" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(tagFit.text)}</text>
  ${titleSvg}
  ${subSvg}
  <text x="90" y="1330" font-size="34" fill="${t.sub}" opacity="0.85" font-family="'PingFang SC','Microsoft YaHei',sans-serif">@闭着眼睛学数理化</text>
</svg>`;
}

export function renderStepsSvg(spec: StepsSpec): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.blue;
  const titleFit = fitText(spec.title, 920, 64, 40);
  // 自适应 3~7 个步骤：卡片高度/间距/字号随数量缩放，并在可用区域内整体垂直居中
  const steps = spec.steps.slice(0, 7);
  const n = Math.max(steps.length, 1);
  const TOP = 300; // 标题与装饰条之下
  const BOTTOM = 1330; // 水印之上
  const avail = BOTTOM - TOP;
  const gap = n >= 6 ? 18 : n === 5 ? 26 : 40;
  const cardH = Math.min(210, Math.floor((avail - (n - 1) * gap) / n));
  const totalH = n * cardH + (n - 1) * gap;
  const y0 = TOP + Math.max(0, Math.floor((avail - totalH) / 2));
  const circleR = Math.min(46, Math.round(cardH * 0.26));
  const cx = 116 + circleR; // 序号圆心 x（卡左 80 + 内边距 36 + 半径）
  const textX = cx + circleR + 44;
  const textW = 1000 - textX - 40; // 卡右缘 1000，留 40 内边距
  const nameFont = Math.min(44, Math.round(cardH * 0.26));
  const descFont = Math.min(32, Math.round(cardH * 0.19));
  const descLines = cardH >= 150 ? 2 : 1; // 矮卡片只放一行说明
  const stepSvg = steps
    .map((s, i) => {
      const y = y0 + i * (cardH + gap);
      const nameFit = fitText(s.t, textW, nameFont, 24); // 步骤名单行缩字号
      const dFit = fitLines(s.d, textW, descFont, Math.min(22, descFont), descLines); // 说明缩字号+省略号
      const dLines = dFit.lines;
      const nameY = y + (descLines > 1 ? Math.round(cardH * 0.36) : Math.round(cardH * 0.42));
      const descY0 = y + (descLines > 1 ? Math.round(cardH * 0.72) : Math.round(cardH * 0.78));
      return `
  <rect x="80" y="${y}" width="920" height="${cardH}" rx="${Math.min(24, Math.round(cardH * 0.12))}" fill="#ffffff" opacity="${spec.theme === "dark" ? "0.08" : "0.85"}"/>
  <circle cx="${cx}" cy="${y + Math.round(cardH / 2)}" r="${circleR}" fill="${t.accent}"/>
  <text x="${cx}" y="${y + Math.round(cardH / 2) + Math.round(circleR * 0.36)}" font-size="${Math.round(circleR * 1.05)}" font-weight="800" fill="#ffffff" text-anchor="middle" font-family="'PingFang SC',sans-serif">${i + 1}</text>
  <text x="${textX}" y="${nameY}" font-size="${nameFit.fontSize}" font-weight="700" fill="${t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(nameFit.text)}</text>
  ${dLines
    .map(
      (l, j) =>
        `<text x="${textX}" y="${descY0 + j * Math.round(dFit.fontSize * 1.35)}" font-size="${dFit.fontSize}" fill="${t.sub}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(l)}</text>`,
    )
    .join("")}`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <text x="80" y="200" font-size="${titleFit.fontSize}" font-weight="800" fill="${t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(titleFit.text)}</text>
  <rect x="80" y="240" width="120" height="10" rx="5" fill="${t.accent}"/>
  ${stepSvg}
  <text x="80" y="1360" font-size="30" fill="${t.sub}" opacity="0.85" font-family="'PingFang SC','Microsoft YaHei',sans-serif">@闭着眼睛学数理化 · 收藏≠学会，动手才算</text>
</svg>`;
}

// ============ 代码卡渲染辅助 ============

/** 字符显示宽度：ASCII 算 1，其余（CJK 等）算 2 */
function charWidth(ch: string): number {
  return /[ -~]/.test(ch) ? 1 : 2;
}

/** 找到行内注释起点（整行注释返回行首位置，无注释返回 -1）。要求注释符前是空白，避免误判 https:// 等 */
function findCommentStart(line: string): number {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#") || trimmed.startsWith("//")) return line.length - trimmed.length;
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1];
    if (prev !== " " && prev !== "\t") continue;
    if (line[i] === "#" || (line[i] === "/" && line[i + 1] === "/")) return i;
  }
  return -1;
}

type CodeSeg = { text: string; comment: boolean };
type CodeRow = { segs: CodeSeg[]; num: number | null };

const CODE_BASE_FONT = 30; // 基准字号（内容多时自适应缩小）
const CODE_MAX_UNITS = 44; // 基准字号下每行最大显示宽度（约 850px）

/** 不允许出现在行首的标点（折行时贴到上一行末尾，允许轻微超出） */
const CODE_NO_LINE_START = new Set([..."，。、；：？！）】》」』”’%),.;:!?]"]);
/** 不允许出现在行尾的标点（折行时挪到下一行开头） */
const CODE_NO_LINE_END = new Set([..."（【《「『“‘([<"]);

/** 把一行代码按显示宽度折成多个可视行；注释段保持绿色。
 *  排版规则：标点不出现在行首（悬挂到上行末尾）、开括号不停留在行尾、
 *  续行缩进封顶 12 单位 + 4（深缩进代码的注释不会越挤越窄）、续行无行号 */
function wrapCodeLine(line: string, lineNo: number, maxUnits: number): CodeRow[] {
  const commentAt = findCommentStart(line);
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const indentUnits = [...indent].reduce((w, ch) => w + (ch === "\t" ? 4 : 1), 0);
  const effIndent = Math.min(indentUnits, 12); // 缩进封顶，避免深层嵌套注释被挤成窄条

  const chars: { ch: string; comment: boolean; w: number }[] = [...line].map((ch, i) => ({
    ch,
    comment: commentAt >= 0 && i >= commentAt,
    w: charWidth(ch),
  }));

  const rows: { ch: string; comment: boolean; w: number }[][] = [];
  let cur: { ch: string; comment: boolean; w: number }[] = [];
  let curW = 0;
  const limit = (rowIdx: number) => (rowIdx === 0 ? maxUnits : Math.max(20, maxUnits - effIndent - 4));

  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (curW + c.w > limit(rows.length) && cur.length > 0) {
      // 开括号类字符不要留在行尾：挪到下一行
      while (cur.length && CODE_NO_LINE_END.has(cur[cur.length - 1].ch)) {
        const tail = cur.pop()!;
        curW -= tail.w;
        i--; // 回退一个待处理字符
        chars.splice(i + 1, 0, tail); // 插回待处理流
      }
      rows.push(cur);
      cur = [];
      curW = 0;
      // 标点不允许出现在行首：连续标点悬挂到上一行末尾
      while (i < chars.length && CODE_NO_LINE_START.has(chars[i].ch)) {
        rows[rows.length - 1].push(chars[i]);
        i++;
      }
      continue;
    }
    cur.push(c);
    curW += c.w;
    i++;
  }
  if (cur.length) rows.push(cur);

  return rows.map((rowChars, ri) => {
    const prefix = ri === 0 ? "" : " ".repeat(effIndent + 4);
    const segs: CodeSeg[] = [];
    if (prefix) segs.push({ text: prefix, comment: false });
    for (const c of rowChars) {
      const last = segs[segs.length - 1];
      if (last && last.comment === c.comment) last.text += c.ch;
      else segs.push({ text: c.ch, comment: c.comment });
    }
    return { segs, num: ri === 0 ? lineNo : null };
  });
}

export function renderCodeSvg(spec: CodeSpec): string {
  // 字号自适应：从 30px 往小试，行宽按比例放大、行高收紧，直到全部可视行放得下
  const lineOffset = spec.lineOffset ?? 0;
  const srcLines = spec.code.split("\n");
  let fontSize = 22;
  let lineH = Math.round(22 * 1.72);
  let rows: CodeRow[] = [];
  let truncated = false;
  for (const fs of [30, 28, 26, 24, 22]) {
    const lh = Math.round(fs * 1.72);
    const units = Math.floor((CODE_MAX_UNITS * CODE_BASE_FONT) / fs);
    const maxRows = Math.floor((1244 - 290) / lh);
    const wrapped: CodeRow[] = [];
    srcLines.forEach((line, i) => {
      wrapped.push(...wrapCodeLine(line, lineOffset + i + 1, units));
    });
    fontSize = fs;
    lineH = lh;
    if (wrapped.length <= maxRows) {
      rows = wrapped;
      truncated = false;
      break;
    }
    if (fs === 22) {
      rows = wrapped.slice(0, maxRows);
      truncated = true;
    }
  }

  const headFit = fitText(spec.title + " · " + spec.lang, 880, 28, 18);
  const CODE_COLOR = "#e7e5e4";
  const COMMENT_COLOR = "#7dd3a8";
  const lineSvg = rows
    .map((row, i) => {
      const spans = row.segs
        .map((seg) => {
          const safe = seg.text.replace(/ /g, "\u00A0").replace(/\t/g, "\u00A0\u00A0\u00A0\u00A0");
          return `<tspan fill="${seg.comment ? COMMENT_COLOR : CODE_COLOR}">${esc(safe)}</tspan>`;
        })
        .join("");
      return `<text x="150" y="${290 + i * lineH}" font-size="${fontSize}" font-family="'JetBrains Mono','SF Mono',Consolas,monospace">${spans}</text>`;
    })
    .join("");
  const lineNums = rows
    .map((row, i) =>
      row.num != null
        ? `<text x="110" y="${290 + i * lineH}" font-size="${Math.max(18, fontSize - 4)}" fill="#57534e" text-anchor="end" font-family="monospace">${row.num}</text>`
        : "",
    )
    .join("");
  const boxH = Math.min(1184, Math.max(320, 200 + (rows.length + (truncated ? 1 : 0)) * lineH));
  const noteFit = fitText(spec.note, 900, 36, 24);
  // 复杂度说明固定在图片底部、水印上方（不跟随代码框高度浮动）
  const noteY = 1324;
  const wmY = 1380;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <rect width="1080" height="1440" fill="#1c1917"/>
  <rect x="60" y="100" width="960" height="${boxH}" rx="24" fill="#292524" stroke="#44403c"/>
  <circle cx="110" cy="150" r="12" fill="#ef4444"/><circle cx="150" cy="150" r="12" fill="#f59e0b"/><circle cx="190" cy="150" r="12" fill="#22c55e"/>
  <text x="540" y="158" font-size="${headFit.fontSize}" fill="#a8a29e" text-anchor="middle" font-family="'PingFang SC',sans-serif">${esc(headFit.text)}</text>
  ${lineNums}
  ${lineSvg}
  ${truncated ? `<text x="150" y="${290 + rows.length * lineH}" font-size="${Math.max(20, fontSize - 2)}" fill="#78716c" font-family="'PingFang SC',sans-serif">… 其余代码见下一张代码卡或正文</text>` : ""}
  <text x="60" y="${noteY}" font-size="${noteFit.fontSize}" font-weight="700" fill="#fbbf24" font-family="'PingFang SC','Microsoft YaHei',sans-serif">⏱ ${esc(noteFit.text)}</text>
  <text x="60" y="${wmY}" font-size="30" fill="#78716c" font-family="'PingFang SC','Microsoft YaHei',sans-serif">@闭着眼睛学数理化 · 完整版见正文</text>
</svg>`;
}

/** 题目描述图：大段文字按段落排版，36→26px 自适应缩字号；超长分页由服务端 chunkProblemCards 完成 */
export function renderProblemSvg(spec: ProblemSpec & ProblemLayoutOverride): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.blue;
  const titleFit = fitText(spec.title, 920, 58, 36);
  const TEXT_X = 90;
  const TEXT_W = 900;
  const TOP_Y = 330; // 文字区顶部（标题与装饰条之下）
  const BOTTOM_Y = 1300; // 水印之上
  const avail = BOTTOM_Y - TOP_Y;
  const paragraphs = spec.text.split(/\n+/).map((p) => p.trim()).filter(Boolean).map((p) => {
    // 段首 Markdown 标记：# / ## 是标题，- / * 是列表项（换成 · 前缀）
    let t = 0;
    let q = p;
    if (/^##\s+/.test(q)) {
      t = 2;
      q = q.replace(/^##\s+/, "");
    } else if (/^#\s+/.test(q)) {
      t = 1;
      q = q.replace(/^#\s+/, "");
    } else if (/^[-*]\s+/.test(q)) {
      q = "· " + q.replace(/^[-*]\s+/, "");
    }
    return { t, q };
  });
  // 行距/段距/字号用户覆盖：留空=自动；非法值 clamp（行距 [1,3]、段距 [0,3]、字号 [14,36] 取偶数）
  let fontSize = 26;
  let lineH = Math.round(26 * 1.62);
  let lines: RichLine[] = [];
  let clamped = false;
  let paraGapPx = Math.round(26 * 1.62);
  const lineGapUser = (spec.lineGap as number) > 0 && isFinite(+(spec.lineGap as number)) ? Math.min(3, Math.max(1, +(spec.lineGap as number))) : 0;
  const paraGapUser = spec.paraGap == null ? 1 : isFinite(+spec.paraGap) ? Math.min(3, Math.max(0, +spec.paraGap)) : 1;
  const fontSizeUser = (spec.fontSize as number) > 0 && isFinite(+(spec.fontSize as number)) ? Math.min(36, Math.max(14, Math.round(+(spec.fontSize as number) / 2) * 2)) : 0;
  // 三维自适应：段距档 [1,.5,.2,0] × 字号 36→14 × 行距档，首个放得下即停，优先保字号
  // 用户显式设置了行距时先试用户值、失效回退 1.32；段距档放开到 0，保证零截断
  let paraScale = 1;
  let fitted = false;
  let lh = 0;
  let paraPx = 0;
  let wrapped: RichLine[] = [];
  let lastFs = 0;
  const lineGaps = lineGapUser ? [lineGapUser, 1.32] : [1.62, 1.45, 1.32];
  const paraScales = [1, 0.5, 0.2, 0];
  W6: for (const ps of paraScales) {
    for (let fs = fontSizeUser || 36; fs >= 14; fs -= 2) {
      for (const lg of lineGaps) {
        lh = Math.round(fs * lg);
        paraPx = Math.round(lh * paraGapUser * ps);
        wrapped = [];
        paragraphs.forEach((p, i) => {
          // 标题行按放大后的字号折行，避免换行溢出
          const wrappedPara: RichLine[] = wrapRichText(p.q, Math.floor(TEXT_W / (fs + (p.t === 1 ? 10 : p.t === 2 ? 5 : 0))));
          if (!wrappedPara.length) return;
          if (p.t) wrappedPara.forEach((line) => { line.hl = p.t; });
          if (i > 0) wrappedPara[0].pre = paraPx; // 段间距
          wrapped.push(...wrappedPara);
        });
        // 标题行行高抬升：字号放大后至少 1.15 倍行距
        const totalH = wrapped.reduce((a, l) => a + (l.hl ? Math.max(lh, Math.round((fs + (l.hl === 1 ? 10 : 5)) * 1.15)) : lh) + (l.pre || 0), 0);
        fontSize = fs;
        lineH = lh;
        paraGapPx = paraPx;
        paraScale = ps;
        lastFs = fs;
        if (totalH <= avail) {
          lines = wrapped;
          clamped = false;
          fitted = true;
          break W6;
        }
      }
    }
  }
  if (!fitted) {
    // 保底：最后尝试档仍放不下则截断加省略号
    const fs = lastFs;
    lines = wrapped;
    clamped = true;
    while (lines.length > 1 && lines.reduce((a, l) => a + (l.hl ? Math.max(lh, Math.round((fs + (l.hl === 1 ? 10 : 5)) * 1.15)) : lh) + (l.pre || 0), 0) > avail) lines.pop();
    const last = lines[lines.length - 1] ?? [];
    while (last.length > 1 && (last.reduce((a, x) => a + charUnits(x.ch), 0) + 1) * (fs + (last.hl === 1 ? 10 : last.hl === 2 ? 5 : 0)) > TEXT_W) last.pop();
    last.push({ ch: "…", bold: false });
  }
  // 行距自动模式：随填充度收紧（1.62 → 1.45 → 1.32），段距按倍率跟随当前档
  if (!lineGapUser) {
    const curH = lines.length * lineH + lines.reduce((a, l) => a + (l.pre || 0), 0);
    if (curH > avail * 0.72) {
      lineH = Math.round(fontSize * 1.32);
      paraGapPx = Math.round(lineH * paraGapUser * paraScale);
    } else if (curH > avail * 0.45) {
      lineH = Math.round(fontSize * 1.45);
      paraGapPx = Math.round(lineH * paraGapUser * paraScale);
    }
    lines.forEach((l) => { if (l.pre != null) l.pre = paraGapPx; });
  }
  // 内容不足半页时垂直居中，接近满页时顶对齐
  const totalH = lines.length * lineH + lines.reduce((a, l) => a + (l.pre || 0), 0);
  const startY = TOP_Y + (totalH < avail * 0.5 ? Math.round((avail - totalH) / 2) : 0);
  let curY = startY;
  const textSvg = lines
    .map((l, _i) => {
      curY += (l.pre || 0) + (l.hl ? Math.max(lineH, Math.round((fontSize + (l.hl === 1 ? 10 : 5)) * 1.15)) : lineH);
      return l.length
        ? `<text x="${TEXT_X}" y="${curY}" font-size="${fontSize + (l.hl === 1 ? 10 : l.hl === 2 ? 5 : 0)}"${l.hl ? ' font-weight="700"' : ""} fill="${l.hl ? t.accent : t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${richCharsToTspans(l)}</text>`
        : "";
    })
    .join("");
  const showMore = clamped || spec.truncated;
  // 分页中间页提示「余下见下一张」，末页提示「余下题目见正文」
  const showMoreText = (() => {
    const m = /（(\d+)\/(\d+)）$/.exec(spec.title || "");
    return m && +m[1] < +m[2] ? "… 余下见下一张" : "… 余下题目见正文";
  })();

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <text x="80" y="200" font-size="${titleFit.fontSize}" font-weight="800" fill="${t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(titleFit.text)}</text>
  <rect x="80" y="240" width="120" height="10" rx="5" fill="${t.accent}"/>
  ${textSvg}
  ${showMore ? `<text x="80" y="1330" font-size="30" font-weight="700" fill="${t.accent}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${showMoreText}</text>` : ""}
  <text x="80" y="1380" font-size="30" fill="${t.sub}" opacity="0.85" font-family="'PingFang SC','Microsoft YaHei',sans-serif">@闭着眼睛学数理化 · 先读题，再看解析</text>
</svg>`;
}

/** 金句卡 */
export function renderQuoteSvg(spec: QuoteSpec): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.orange;
  const quoteFit = fitLines(spec.quote, 900, 64, 38, 5); // 自适应缩字号 + 词感知折行
  const quoteLineH = Math.round(quoteFit.fontSize * 1.44);
  const quoteSvg = quoteFit.lines
    .map(
      (line, i) =>
        `<text x="540" y="${560 + i * quoteLineH}" font-size="${quoteFit.fontSize}" font-weight="800" fill="${t.text}" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(line)}</text>`,
    )
    .join("");
  const quoteLineCount = quoteFit.lines.length;
  const tagFit = fitText(spec.title, 830, 34, 22); // 胶囊标题缩字号
  const tagW = Math.max(72, Math.ceil(textWidthPx(tagFit.text, tagFit.fontSize)) + 48);
  const subFit = fitText(spec.sub, 900, 36, 24);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <text x="70" y="300" font-size="300" font-weight="800" fill="${t.accent}" opacity="0.18" font-family="Georgia,serif">“</text>
  <rect x="90" y="120" width="${tagW}" height="64" rx="32" fill="${t.accent}"/>
  <text x="114" y="164" font-size="${tagFit.fontSize}" font-weight="700" fill="#ffffff" font-family="'PingFang SC',sans-serif">${esc(tagFit.text)}</text>
  ${quoteSvg}
  <rect x="420" y="${620 + quoteLineCount * quoteLineH}" width="240" height="8" rx="4" fill="${t.accent}"/>
  <text x="540" y="${700 + quoteLineCount * quoteLineH}" font-size="${subFit.fontSize}" fill="${t.sub}" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(subFit.text)}</text>
  <text x="540" y="1340" font-size="32" fill="${t.sub}" opacity="0.8" text-anchor="middle" font-family="'PingFang SC',sans-serif">@闭着眼睛学数理化</text>
</svg>`;
}

/** 要点清单卡 */
export function renderListSvg(spec: ListSpec): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.green;
  const titleFit = fitText(spec.title, 920, 58, 36);
  const items = spec.items.slice(0, 7);
  const itemSvg = items
    .map((item, i) => {
      const y = 340 + i * 130;
      const itemFit = fitLines(item, 800, 36, 26, 2); // 缩字号+省略号
      const lines = itemFit.lines;
      return `
  <rect x="80" y="${y}" width="920" height="${lines.length > 1 ? 108 : 84}" rx="20" fill="#ffffff" opacity="${spec.theme === "dark" ? "0.08" : "0.9"}"/>
  <rect x="104" y="${y + 22}" width="40" height="40" rx="10" fill="${t.accent}"/>
  <text x="124" y="${y + 52}" font-size="28" font-weight="800" fill="#ffffff" text-anchor="middle" font-family="'PingFang SC',sans-serif">${i + 1}</text>
  ${lines
    .map(
      (l, j) =>
        `<text x="172" y="${y + 52 + j * Math.round(itemFit.fontSize * 1.2)}" font-size="${itemFit.fontSize}" font-weight="${j === 0 ? 600 : 400}" fill="${t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(l)}</text>`,
    )
    .join("")}`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <text x="80" y="190" font-size="${titleFit.fontSize}" font-weight="800" fill="${t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(titleFit.text)}</text>
  <rect x="80" y="228" width="120" height="10" rx="5" fill="${t.accent}"/>
  ${itemSvg}
  <text x="80" y="1380" font-size="30" fill="${t.sub}" opacity="0.85" font-family="'PingFang SC',sans-serif">@闭着眼睛学数理化 · 建议收藏</text>
</svg>`;
}

/** 对比卡（左右两栏） */
export function renderCompareSvg(spec: CompareSpec): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.blue;
  const titleFit = fitText(spec.title, 960, 58, 36);
  const col = (x: number, label: string, points: string[], good: boolean) => {
    const accent = good ? "#16a34a" : "#dc2626";
    const labelFit = fitText(label, 360, 34, 22);
    const items = points.slice(0, 4);
    const pts = items
      .map((pt, i) => {
        const ptFit = fitLines(pt, 380, 32, 24, 2);
        const lh = Math.round(ptFit.fontSize * 1.35);
        return ptFit.lines
          .map(
            (l, j) =>
              `<text x="${x + 36}" y="${470 + i * 110 + j * lh}" font-size="${ptFit.fontSize}" fill="${t.text}" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(l)}</text>`,
          )
          .join("");
      })
      .join("");
    return `
  <rect x="${x}" y="330" width="450" height="${420 + items.length * 30}" rx="24" fill="#ffffff" opacity="${spec.theme === "dark" ? "0.08" : "0.92"}"/>
  <rect x="${x}" y="330" width="450" height="72" rx="24" fill="${accent}"/>
  <rect x="${x}" y="378" width="450" height="24" fill="${accent}"/>
  <text x="${x + 225}" y="378" font-size="${labelFit.fontSize}" font-weight="800" fill="#ffffff" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${good ? "✓" : "✗"} ${esc(labelFit.text)}</text>
  ${pts}`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <text x="540" y="210" font-size="${titleFit.fontSize}" font-weight="800" fill="${t.text}" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(titleFit.text)}</text>
  ${col(60, spec.leftLabel, spec.leftPoints, false)}
  ${col(570, spec.rightLabel, spec.rightPoints, true)}
  <text x="540" y="1380" font-size="30" fill="${t.sub}" opacity="0.85" text-anchor="middle" font-family="'PingFang SC',sans-serif">@闭着眼睛学数理化</text>
</svg>`;
}

/** 结尾互动卡 */
export function renderEndSvg(spec: EndSpec): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.orange;
  // 底部关注按钮：文字可用 spec.cta 调整；字号收缩 + 按钮宽度双向自适应，绝不截断
  const ctaFit = fitText((spec.cta ?? "").trim() || "关注 @闭着眼睛学数理化", 860, 40, 24);
  const ctaBtnW = Math.min(940, Math.max(280, Math.ceil(textWidthPx(ctaFit.text, ctaFit.fontSize)) + 120));
  const titleFit = fitLines(spec.title, 920, 68, 40, 3);
  const titleLineH = Math.round(titleFit.fontSize * 1.4);
  // 引导语起始位置跟随标题实际行数，标题 3 行时也不重叠
  const linesY0 = 640 + titleFit.lines.length * titleLineH + 50;
  const lineSvg = spec.lines
    .slice(0, 3)
    .map((l, i) => {
      const lineFit = fitText(l, 940, 40, 26);
      return `<text x="540" y="${linesY0 + i * 72}" font-size="${lineFit.fontSize}" fill="${t.sub}" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(lineFit.text)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <circle cx="540" cy="420" r="110" fill="${t.accent}" opacity="0.14"/>
  <text x="540" y="478" font-size="130" text-anchor="middle">💬</text>
  ${titleFit.lines
    .map(
      (line, i) =>
        `<text x="540" y="${640 + i * titleLineH}" font-size="${titleFit.fontSize}" font-weight="800" fill="${t.text}" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(line)}</text>`,
    )
    .join("")}
  ${lineSvg}
  <rect x="${Math.round(540 - ctaBtnW / 2)}" y="1180" width="${ctaBtnW}" height="88" rx="44" fill="${t.accent}"/>
  <text x="540" y="1238" font-size="${ctaFit.fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle" font-family="'PingFang SC',sans-serif">${esc(ctaFit.text)}</text>
</svg>`;
}

/** 素材原图卡：拍立得式白框 + 居中图片 + 底部说明 */
export function renderPhotoSvg(spec: PhotoSpec): string {
  // AI 生图：画面铺满整张卡片（slice 裁切填满），底色跟随笔记配色，水印浮于画面之上
  if (spec.source === "ai") {
    const t = THEMES[(spec.theme ?? "orange") as ThemeName] ?? THEMES.orange;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <rect width="1080" height="1440" fill="${t.bg2}"/>
  <image href="${spec.dataUrl}" x="0" y="0" width="1080" height="1440" preserveAspectRatio="xMidYMid slice"/>
  <rect x="330" y="1364" width="420" height="52" rx="26" fill="#000000" opacity="0.28"/>
  <text x="540" y="1399" font-size="26" fill="#ffffff" text-anchor="middle" font-family="'PingFang SC',sans-serif">@闭着眼睛学数理化</text>
</svg>`;
  }
  const cardX = 60, cardY = 60, cardW = 960, cardH = 1320;
  const pad = 42;
  const captionH = spec.title ? 116 : 0;
  const maxW = cardW - pad * 2;
  const maxH = cardH - pad * 2 - captionH - 20;
  // 尺寸未知时按 3:2 横图兜底；已知尺寸限制最高放大 1.6 倍防止模糊
  const known = spec.width > 0 && spec.height > 0;
  const iw = known ? spec.width : 3;
  const ih = known ? spec.height : 2;
  const scale = Math.min(maxW / iw, maxH / ih, known ? 1.6 : Infinity);
  const w = Math.round(iw * scale);
  const h = Math.round(ih * scale);
  const x = Math.round(cardX + (cardW - w) / 2);
  const y = Math.round(cardY + pad + (maxH - h) / 2);
  const captionFit = spec.title ? fitLines(spec.title, 920, 32, 24, 2) : null;
  const captionLines = captionFit?.lines ?? [];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <rect width="1080" height="1440" fill="#f5f1ea"/>
  <rect x="18" y="18" width="1044" height="1404" rx="26" fill="none" stroke="#e2d9c8" stroke-width="3"/>
  <rect x="${cardX + 10}" y="${cardY + 16}" width="${cardW}" height="${cardH}" rx="18" fill="#000000" opacity="0.08"/>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="18" fill="#ffffff"/>
  <image href="${spec.dataUrl}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>
  ${captionLines
    .map(
      (line, i) =>
        `<text x="540" y="${y + h + 62 + i * Math.round((captionFit?.fontSize ?? 32) * 1.4)}" font-size="${captionFit?.fontSize ?? 32}" fill="#57534e" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(line)}</text>`,
    )
    .join("")}
  <text x="540" y="1420" font-size="26" fill="#a8a29e" text-anchor="middle" font-family="'PingFang SC',sans-serif">@闭着眼睛学数理化</text>
</svg>`;
}

/** 流程图占位卡：mermaid 渲染完成前的兜底（实际预览/下载用异步渲染结果） */
export function renderDiagramFallbackSvg(spec: DiagramSpec, message = "流程图渲染中…"): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.blue;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <text x="540" y="660" font-size="${fitText(spec.title, 920, 52, 32).fontSize}" font-weight="800" fill="${t.text}" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(fitText(spec.title, 920, 52, 32).text)}</text>
  <text x="540" y="740" font-size="34" fill="${t.sub}" text-anchor="middle" font-family="'PingFang SC',sans-serif">${esc(message)}</text>
</svg>`;
}

/** 把 mermaid 渲染结果（含 viewBox 的内层 svg）包进 1080×1440 小红书卡片 */
function normalizeMermaidSvg(inner: string): string {
  return inner.replace(/<svg([^>]*)>/, (_m, attrs: string) => {
    const cleaned = attrs
      .replace(/\s(width|height)="[^"]*"/g, "")
      .replace(/\sstyle="[^"]*max-width[^"]*"/g, "");
    return `<svg${cleaned}>`;
  });
}

export function renderDiagramCardSvg(mermaidSvg: string, spec: DiagramSpec): string {
  const gid = nextGradientId();
  const t = THEMES[spec.theme] ?? THEMES.blue;
  const inner = normalizeMermaidSvg(mermaidSvg);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" xml:space="preserve">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1440" fill="url(#${gid})"/>
  <text x="540" y="150" font-size="${fitText(spec.title, 960, 58, 34).fontSize}" font-weight="800" fill="${t.text}" text-anchor="middle" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${esc(fitText(spec.title, 960, 58, 34).text)}</text>
  <line x1="340" y1="190" x2="740" y2="190" stroke="${t.accent}" stroke-width="5" stroke-linecap="round"/>
  <svg x="90" y="240" width="900" height="980">${inner}</svg>
  <text x="540" y="1380" font-size="26" fill="#a8a29e" text-anchor="middle" font-family="'PingFang SC',sans-serif">@闭着眼睛学数理化</text>
</svg>`;
}

export function renderImageSvg(spec: NoteImageSpec): string {
  switch (spec.kind) {
    case "cover":
      return renderCoverSvg(spec);
    case "steps":
      return renderStepsSvg(spec);
    case "code":
      return renderCodeSvg(spec);
    case "problem":
      return renderProblemSvg(spec);
    case "quote":
      return renderQuoteSvg(spec);
    case "list":
      return renderListSvg(spec);
    case "compare":
      return renderCompareSvg(spec);
    case "diagram":
      return renderDiagramFallbackSvg(spec);
    case "end":
      return renderEndSvg(spec);
    case "photo":
      return renderPhotoSvg(spec);
  }
}

/** SVG 字符串 → PNG dataURL（1080×1440） */
export async function svgToPngDataUrl(svg: string, format: "png" | "jpeg" = "png", quality = 0.85): Promise<string> {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG 加载失败"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1440;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 不可用");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1080, 1440);
    ctx.drawImage(img, 0, 0, 1080, 1440);
    return format === "jpeg" ? canvas.toDataURL("image/jpeg", quality) : canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** SVG 字符串 → PNG 下载（1080×1440） */
export async function downloadSvgAsPng(svg: string, filename: string): Promise<void> {
  const dataUrl = await svgToPngDataUrl(svg);
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/** dataURL → 字节数组 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 多个文件打成一个 zip 下载（stored 不压缩 + CRC32 + UTF-8 文件名旗标），批量下载只弹一次保存框 */
export async function downloadZip(files: { name: string; data: Uint8Array }[], zipName: string): Promise<void> {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
    return table;
  })();
  const crc32 = (data: Uint8Array) => {
    let crc = ~0;
    for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 255] ^ (crc >>> 8);
    return ~crc >>> 0;
  };
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const u16 = (v: number) => new Uint8Array([v & 255, (v >>> 8) & 255]);
  const u32 = (v: number) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  let offset = 0;
  for (const f of files) {
    const nameBytes = encoder.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;
    const local = [u32(67324752), u16(20), u16(2048), u16(0), u16(0), u16(33), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0)];
    const central = [u32(33639248), u16(20), u16(20), u16(2048), u16(0), u16(0), u16(33), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)];
    localParts.push(...local, nameBytes, f.data);
    centralParts.push(...central, nameBytes);
    offset += local.reduce((a, p) => a + p.length, 0) + nameBytes.length + size;
  }
  const centralSize = centralParts.reduce((a, p) => a + p.length, 0);
  const all = [...localParts, ...centralParts, u32(101010256), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)];
  const blob = new Blob(all as BlobPart[], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5e3);
}
