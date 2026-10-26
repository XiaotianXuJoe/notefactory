/**
 * 飞书公开文档抓取（纯 HTTP，无需浏览器）：
 * 飞书 docx/wiki 页面是服务端渲染的，HTML 里内嵌完整结构化文档数据
 * （window.DATA 里的 clientVars.block_map）。本模块：
 * 1. 带 Cookie 跟随「游客登录」重定向链拿到 SSR HTML
 * 2. 从 HTML 中提取 block_map 结构化数据
 * 3. 把块树转成干净的 Markdown（标题/列表/代码/表格/加粗/链接）
 * 4. 图片块通过 /space/api/box/stream/download/all/{token} 匿名下载
 */

export type FeishuImage = {
  token: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  dataBase64: string;
};

export type FeishuDoc = {
  title: string;
  content: string;
  images: FeishuImage[];
  warnings: string[];
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 超过 8MB 的图片跳过
const MAX_IMAGES = 30;

// ---------- URL 解析 ----------

function parseFeishuUrl(raw: string): { host: string; token: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("链接格式不正确，请粘贴完整的飞书文档链接");
  }
  const m = u.pathname.match(/^\/(docx|wiki|docs|doc)\/([A-Za-z0-9]+)/);
  if (!m) {
    throw new Error("仅支持飞书文档链接（/docx/ 或 /wiki/ 开头），请检查链接是否完整");
  }
  if (m[1] === "doc" || m[1] === "docs") {
    throw new Error("这是旧版飞书文档（/docs/），暂不支持链接导入，请改用「粘贴文本」，或把文档升级为新版文档");
  }
  return { host: u.host, token: m[2] };
}

// ---------- 带 Cookie 的 HTTP 抓取（手动跟随重定向） ----------

class CookieJar {
  private store = new Map<string, string>();
  addFrom(setCookies: string[]) {
    for (const sc of setCookies) {
      const first = sc.split(";")[0];
      const eq = first.indexOf("=");
      if (eq > 0) this.store.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
    }
  }
  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function fetchWithJar(url: string, jar: CookieJar, maxRedirects = 10): Promise<{ html: string; finalUrl: string }> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const resp = await fetch(current, {
      redirect: "manual",
      headers: { "User-Agent": UA, Cookie: jar.header(), Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(30_000),
    });
    jar.addFrom(resp.headers.getSetCookie());
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) break;
      current = new URL(loc, current).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`飞书页面返回 HTTP ${resp.status}`);
    return { html: await resp.text(), finalUrl: current };
  }
  throw new Error("飞书页面重定向次数过多，抓取失败");
}

/** 下载二进制（图片） */
async function downloadWithJar(url: string, jar: CookieJar): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    let current = url;
    for (let i = 0; i <= 5; i++) {
      const resp = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": UA, Cookie: jar.header() },
        signal: AbortSignal.timeout(30_000),
      });
      jar.addFrom(resp.headers.getSetCookie());
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!resp.ok) return null;
      const mime = resp.headers.get("content-type") ?? "application/octet-stream";
      if (!mime.startsWith("image/")) return null;
      return { bytes: Buffer.from(await resp.arrayBuffer()), mime: mime.split(";")[0] };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- SSR HTML 中的 JSON 提取 ----------

/** 从 marker 后的 "Object({" 或 "= {" 开始做大括号配对，返回解析后的 JSON */
function extractJsonObject(html: string, marker: string): unknown | null {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const s = i + marker.length;
  if (html.startsWith("null", s)) return null;
  if (html[s] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(s, k + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

// ---------- 飞书块类型 ----------

type AttrPool = { nextNum?: number; numToAttrib?: Record<string, [string, string]> | null };
type AttributedText = {
  apool?: AttrPool;
  initialAttributedTexts?: { attribs?: Record<string, string> | null; text?: Record<string, string> | null } | null;
};
type Block = {
  id: string;
  data: {
    type: string;
    children?: string[] | null;
    text?: AttributedText;
    image?: { token?: string; mimeType?: string; width?: number; height?: number; name?: string };
    board?: { token?: string };
    file?: { token?: string; name?: string };
    columns_id?: string[];
    rows_id?: string[];
    cell_set?: Record<string, { block_id?: string }>;
    [k: string]: unknown;
  };
};

// ---------- Etherpad 属性串解析（加粗/链接/行内代码/删除线） ----------

type InlineSegment = { text: string; bold: boolean; strike: boolean; code: boolean; link?: string };

function parseInlineText(t: AttributedText | undefined): string {
  const texts = t?.initialAttributedTexts?.text;
  if (!texts) return "";
  const attribs = t?.initialAttributedTexts?.attribs ?? {};
  const pool = t?.apool?.numToAttrib ?? {};

  const out: string[] = [];
  for (const key of Object.keys(texts).sort((a, b) => Number(a) - Number(b))) {
    const text = texts[key] ?? "";
    const attrStr = attribs?.[key] ?? "";
    if (!text) continue;

    // 解析操作序列：(*attr)* (|lines)? +len —— len 为 36 进制
    const segments: InlineSegment[] = [];
    let pos = 0;
    const opRe = /((?:\*[0-9a-z]+)*)(?:\|([0-9a-z]+))?\+([0-9a-z]+)/g;
    let m: RegExpExecArray | null;
    while ((m = opRe.exec(attrStr))) {
      const len = parseInt(m[3], 36);
      if (!Number.isFinite(len) || len <= 0) continue;
      const seg: InlineSegment = { text: text.slice(pos, pos + len), bold: false, strike: false, code: false };
      pos += len;
      const attrIds = m[1].match(/\*([0-9a-z]+)/g)?.map((s2) => s2.slice(1)) ?? [];
      for (const aid of attrIds) {
        const kv = pool[aid];
        if (!kv) continue;
        if (kv[0] === "bold" && kv[1] === "true") seg.bold = true;
        else if (kv[0] === "strikethrough" && kv[1] === "true") seg.strike = true;
        else if (kv[0] === "inline-code" || (kv[0] === "code" && kv[1] === "true")) seg.code = true;
        else if (kv[0] === "link" && kv[1]) seg.link = decodeURIComponent(kv[1]);
      }
      segments.push(seg);
      if (pos >= text.length) break;
    }
    if (pos < text.length) segments.push({ text: text.slice(pos), bold: false, strike: false, code: false });

    // 渲染为 markdown，合并相邻同样式片段
    let line = "";
    for (const seg of segments) {
      let s2 = seg.text;
      if (!s2) continue;
      if (seg.code) s2 = `\`${s2}\``;
      if (seg.bold) s2 = `**${s2}**`;
      if (seg.strike) s2 = `~~${s2}~~`;
      if (seg.link) s2 = `[${s2}](${seg.link})`;
      line += s2;
    }
    // 清理相邻加粗之间的边界（**a****b** → **a** **b** 太啰嗦，直接合并标记）
    line = line.replace(/\*\*\*\*/g, "");
    out.push(line);
  }
  return out.join("\n");
}

// ---------- 块树 → Markdown ----------

type Ctx = {
  blockMap: Record<string, Block>;
  images: { token: string; name: string; mime: string; width: number; height: number }[];
  warnings: Set<string>;
  imageCount: number;
};

function blockToMarkdown(block: Block, ctx: Ctx, depth: number, out: string[]) {
  const d = block.data;
  const text = parseInlineText(d.text).trimEnd();
  const children = () => {
    for (const cid of d.children ?? []) {
      const child = ctx.blockMap[cid];
      if (child) blockToMarkdown(child, ctx, depth, out);
    }
  };

  switch (d.type) {
    case "page":
      children();
      break;
    case "heading1":
    case "heading2":
    case "heading3":
    case "heading4":
    case "heading5":
    case "heading6":
    case "heading7":
    case "heading8":
    case "heading9": {
      const level = Math.min(Number(d.type.slice(7)), 6);
      if (text) out.push("", `${"#".repeat(level)} ${text}`, "");
      break;
    }
    case "bullet":
      if (text) out.push(`${"  ".repeat(depth)}- ${text}`);
      for (const cid of d.children ?? []) {
        const child = ctx.blockMap[cid];
        if (child) blockToMarkdown(child, ctx, depth + 1, out);
      }
      break;
    case "ordered":
      if (text) out.push(`${"  ".repeat(depth)}1. ${text}`);
      for (const cid of d.children ?? []) {
        const child = ctx.blockMap[cid];
        if (child) blockToMarkdown(child, ctx, depth + 1, out);
      }
      break;
    case "todo":
      if (text) out.push(`- [ ] ${text}`);
      break;
    case "code":
      out.push("", "```", text, "```", "");
      break;
    case "quote":
      if (text) out.push(`> ${text}`);
      break;
    case "quote_container":
    case "callout":
    case "grid":
    case "grid_column":
      children();
      break;
    case "table": {
      const cols = d.columns_id ?? [];
      const rows = d.rows_id ?? [];
      const cellSet = d.cell_set ?? {};
      if (cols.length && rows.length) {
        out.push("");
        rows.forEach((rowId, ri) => {
          const cells = cols.map((colId) => {
            const cellId = cellSet[`${rowId}${colId}`]?.block_id;
            const cell = cellId ? ctx.blockMap[cellId] : undefined;
            // 单元格里一般是若干 text 块
            const parts: string[] = [];
            for (const cid of cell?.data.children ?? []) {
              const cb = ctx.blockMap[cid];
              const t2 = cb ? parseInlineText(cb.data.text).trim() : "";
              if (t2) parts.push(t2);
            }
            return parts.join(" ").replace(/\|/g, "\\|");
          });
          out.push(`| ${cells.join(" | ")} |`);
          if (ri === 0) out.push(`| ${cols.map(() => "---").join(" | ")} |`);
        });
        out.push("");
      }
      break;
    }
    case "table_cell":
      break; // 由 table 统一处理
    case "divider":
      out.push("", "---", "");
      break;
    case "image": {
      const token = d.image?.token;
      if (token) {
        ctx.imageCount++;
        if (ctx.images.length < MAX_IMAGES) {
          ctx.images.push({
            token,
            name: d.image?.name || `图片${ctx.imageCount}`,
            mime: d.image?.mimeType || "image/png",
            width: d.image?.width ?? 0,
            height: d.image?.height ?? 0,
          });
        }
        out.push("", `![${d.image?.name || `图片${ctx.imageCount}`}](attachment://${token})`, "");
      }
      break;
    }
    case "board":
    case "whiteboard":
      out.push("", "> ［此处为飞书画板，链接导入暂不支持画板内容，请在编辑器中手动补充截图］", "");
      ctx.warnings.add("文档包含画板，画板内容无法通过链接导入，已用占位标记标出位置");
      break;
    case "sheet":
    case "bitable":
      out.push("", "> ［此处为嵌入的电子表格/多维表格，暂不支持导入，请手动补充］", "");
      ctx.warnings.add("文档包含嵌入表格，已用占位标记标出位置");
      break;
    case "file": {
      out.push("", `> ［附件：${d.file?.name ?? "文件"}］`, "");
      break;
    }
    case "view":
    case "undefined":
      children();
      break;
    default:
      // 其他带文本的块按普通段落处理
      if (text) out.push(text);
      else children();
  }
}

// ---------- 主入口 ----------

export async function fetchFeishuDoc(rawUrl: string): Promise<FeishuDoc> {
  const { host } = parseFeishuUrl(rawUrl);
  const jar = new CookieJar();

  let html: string;
  try {
    ({ html } = await fetchWithJar(rawUrl, jar));
  } catch (e) {
    throw new Error(`飞书页面访问失败：${(e as Error).message}。请检查链接是否正确、文档是否已开启「互联网上获得链接的人可阅读」`);
  }

  // 标题：SERVER_DATA.meta.title
  const serverData = extractJsonObject(html, "window.SERVER_DATA = Object(") as
    | { meta?: { title?: string } }
    | null;
  let title = serverData?.meta?.title?.trim() ?? "";

  // 正文：clientVars.block_map
  const clientVars = extractJsonObject(html, "clientVars: Object(") as
    | { data?: { block_map?: Record<string, Block>; block_sequence?: string[]; has_more?: boolean } }
    | null;
  const blockMap = clientVars?.data?.block_map;

  if (!blockMap || Object.keys(blockMap).length === 0) {
    // 通常是文档未公开：SSR 不会内嵌内容
    if (html.includes("登录") || html.includes("login") || html.includes("无权限") || html.includes("permission")) {
      throw new Error("文档未对互联网公开（需要登录飞书才能查看）。请在飞书中打开文档：右上角「分享」→ 开启「互联网上获得链接的人可阅读」，然后重新导入");
    }
    throw new Error("未能从页面中提取文档内容，该文档类型可能不受支持，请改用「粘贴文本」导入");
  }

  // 找到 page 根块，从它的 children 开始遍历（保证顺序正确）
  const root = Object.values(blockMap).find((b) => b.data.type === "page");
  const ctx: Ctx = { blockMap, images: [], warnings: new Set(), imageCount: 0 };
  const lines: string[] = [];
  if (root) {
    blockToMarkdown(root, ctx, 0, lines);
  } else {
    // 没有 page 块时退化为按 block_sequence 顺序
    for (const id of clientVars?.data?.block_sequence ?? Object.keys(blockMap)) {
      const b = blockMap[id];
      if (b && b.data.type !== "page") blockToMarkdown(b, ctx, 0, lines);
    }
  }

  if (!title) {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    title = (m?.[1] ?? "飞书文档").replace(/- 飞书云文档\s*$/, "").trim() || "飞书文档";
  }

  if (clientVars?.data?.has_more) {
    ctx.warnings.add("文档内容较长，飞书分页加载，已导入前半部分；如内容不全请分段导入");
  }

  // 清理多余空行
  const content = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (content.length < 20) {
    throw new Error(`提取到的正文过少（${content.length} 字），可能是文档未公开或内容为空，请确认分享设置后重试`);
  }

  // 下载图片
  const images: FeishuImage[] = [];
  for (const img of ctx.images) {
    const got = await downloadWithJar(`https://${host}/space/api/box/stream/download/all/${img.token}`, jar);
    if (!got) {
      ctx.warnings.add(`有图片下载失败（${img.name}），已保留占位标记`);
      continue;
    }
    if (got.bytes.length > MAX_IMAGE_BYTES) {
      ctx.warnings.add(`图片 ${img.name} 超过 8MB，已跳过`);
      continue;
    }
    images.push({ ...img, mime: got.mime, dataBase64: got.bytes.toString("base64") });
  }

  return { title, content, images, warnings: [...ctx.warnings] };
}
