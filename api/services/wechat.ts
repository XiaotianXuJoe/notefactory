/**
 * 微信公众号文章抓取（纯 HTTP）：
 * 公众号文章是服务端渲染的静态 HTML，正文在 <div id="js_content"> 中。
 * 本模块提取正文 DOM 并转成 Markdown 风格的素材文本：
 * - 标题/加粗/列表/引用 保留
 * - <pre> 和 code-snippet 转成代码块
 * - <img data-src> 图片下载后以占位符标记位置，存入素材图片库
 */
import { EnvHttpProxyAgent } from "undici";
import type { FeishuImage } from "./feishu";

// 微信域名 IPv6 连接会超时：强制 IPv4；有代理环境变量时自动走代理
const wxDispatcher = new EnvHttpProxyAgent({ connect: { family: 4, timeout: 15_000 } });

export type WechatArticle = {
  title: string;
  content: string;
  images: FeishuImage[];
  warnings: string[];
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 30;

/** 从 PNG/JPEG/GIF/WebP 文件头解析宽高（失败返回 0，前端按横图兜底） */
export function sniffImageSize(buf: Buffer): { width: number; height: number } {
  try {
    // PNG: 89 50 4E 47 ... IHDR
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG: 扫描 SOFn 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = buf[off + 1];
        const len = buf.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        if (len < 2) break;
        off += 2 + len;
      }
    }
    // WebP: RIFF....WEBP
    if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const fmt = buf.toString("ascii", 12, 16);
      if (fmt === "VP8 ") {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fmt === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      if (fmt === "VP8X") {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      }
    }
  } catch {
    /* 解析失败按未知尺寸处理 */
  }
  return { width: 0, height: 0 };
}

// ---------- HTML 实体解码 ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// ---------- 正文 DOM 提取 ----------

/** 从 <div id="js_content"> 开始按标签配对找到整个正文容器 */
function extractContentDiv(html: string): string | null {
  const m = /<div[^>]*id="js_content"[^>]*>/i.exec(html);
  if (!m) return null;
  let pos = m.index + m[0].length;
  let depth = 1;
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = pos;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(html))) {
    depth += tm[1] === "/" ? -1 : 1;
    if (depth === 0) {
      return html.slice(m.index + m[0].length, tm.index);
    }
  }
  return null;
}

// ---------- DOM → Markdown ----------

type CollectCtx = {
  images: { url: string; name: string }[];
  warnings: Set<string>;
};

function domToMarkdown(html: string, ctx: CollectCtx): string {
  let s = html;

  // 去掉脚本、样式、隐藏节点
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<[^>]*style="[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, "");

  // 图片 → 占位符（先收集 URL）
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcM = /data-src="([^"]+)"/.exec(tag) ?? /src="(https?:\/\/[^"]+)"/.exec(tag);
    if (!srcM) return "";
    const altM = /alt="([^"]*)"/.exec(tag);
    const url = srcM[1];
    if (!url.includes("mmbiz.qpic.cn") && !url.includes("mmbiz.qlogo.cn")) return "";
    ctx.images.push({ url, name: decodeEntities(altM?.[1] ?? "") || `图片${ctx.images.length + 1}` });
    return `\n\n![图片${ctx.images.length}](attachment://${ctx.images.length})\n\n`;
  });

  // 代码块：<pre> 或 code-snippet 容器
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\n{3,}/g, "\n\n").trim();
    return `\n\n\`\`\`\n${code}\n\`\`\`\n\n`;
  });
  s = s.replace(/<div[^>]*class="[^"]*code-snippet__bd[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi, (_, inner) => {
    const code = decodeEntities(
      inner
        .replace(/<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    ).trim();
    return code ? `\n\n\`\`\`\n${code}\n\`\`\`\n\n` : "";
  });

  // 标题
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, inner) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    return text ? `\n\n${"#".repeat(Math.min(Number(lv) + 1, 6))} ${text}\n\n` : "";
  });

  // 加粗
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    return text ? `**${text}**` : "";
  });

  // 列表项 / 引用
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<blockquote[^>]*>/gi, "\n> ");

  // 块级元素 → 换行
  s = s.replace(/<\/(p|section|div|li|tr|figcaption)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // 去掉剩余标签
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  // 清理：行尾空白、多余空行
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \u00a0]+$/g, "").trimEnd())
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// ---------- 主入口 ----------

export async function fetchWechatArticle(rawUrl: string): Promise<WechatArticle> {
  if (!/^https?:\/\/mp\.weixin\.qq\.com\//.test(rawUrl)) {
    throw new Error("仅支持 mp.weixin.qq.com 开头的公众号文章链接");
  }

  let html: string;
  try {
    const resp = await fetch(rawUrl, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
      dispatcher: wxDispatcher,
    } as unknown as RequestInit);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    throw new Error(`公众号文章访问失败：${(e as Error).message}，请检查链接是否正确`);
  }

  if (html.includes("环境异常") || html.includes("去验证") || html.includes("验证当前环境")) {
    throw new Error("微信判定当前访问环境异常（触发反爬验证）。请稍后再试，或改用「粘贴文本」导入");
  }

  // 标题
  const ogTitle = /property="og:title"\s+content="([^"]*)"/.exec(html)?.[1];
  const title = decodeEntities(ogTitle ?? "").trim() || "公众号文章";

  const contentDiv = extractContentDiv(html);
  if (!contentDiv) {
    throw new Error("未能从页面中提取正文（可能是文章已删除或需要验证），请改用「粘贴文本」导入");
  }

  const ctx: CollectCtx = { images: [], warnings: new Set() };
  const content = domToMarkdown(contentDiv, ctx);
  if (content.length < 30) {
    throw new Error(`提取到的正文过少（${content.length} 字），文章可能需要验证才能访问，请改用「粘贴文本」导入`);
  }

  // 下载图片
  const images: FeishuImage[] = [];
  const toFetch = ctx.images.slice(0, MAX_IMAGES);
  if (ctx.images.length > MAX_IMAGES) {
    ctx.warnings.add(`文章图片较多，仅下载了前 ${MAX_IMAGES} 张`);
  }
  for (const img of toFetch) {
    try {
      const resp = await fetch(img.url, {
        headers: { "User-Agent": UA, Referer: "https://mp.weixin.qq.com/" },
        signal: AbortSignal.timeout(30_000),
        dispatcher: wxDispatcher,
      } as unknown as RequestInit);
      if (!resp.ok) {
        ctx.warnings.add(`有图片下载失败（${img.name}），已保留占位标记`);
        continue;
      }
      const mime = (resp.headers.get("content-type") ?? "image/jpeg").split(";")[0];
      if (!mime.startsWith("image/")) continue;
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) {
        ctx.warnings.add(`图片 ${img.name} 超过 8MB，已跳过`);
        continue;
      }
      const { width, height } = sniffImageSize(bytes);
      images.push({
        token: `wx_${images.length + 1}`,
        name: img.name,
        mime,
        width,
        height,
        dataBase64: bytes.toString("base64"),
      });
    } catch {
      ctx.warnings.add(`有图片下载失败（${img.name}），已保留占位标记`);
    }
  }

  return { title, content, images, warnings: [...ctx.warnings] };
}

// 抖音视频元信息导入：短链/长链解析视频 ID，抓 jingxuan 页面取标题/简介/封面/作者与数据
export async function fetchDouyinVideo(rawUrl: string): Promise<WechatArticle> {
  const DY_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
  const metaContent = (html: string, key: string): string => {
    const m = new RegExp("<meta\\b[^>]*(?:property|name)=\"" + key + "\"[^>]*>", "i").exec(html);
    if (!m) return "";
    const c = /content="([^"]*)"/i.exec(m[0]);
    return c ? decodeEntities(c[1]) : "";
  };
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    throw new Error("链接格式不正确，请检查后重试");
  }
  let videoId = "";
  const directM = /\/video\/(\d{15,})/.exec(rawUrl) || /[?&]modal_id=(\d{15,})/.exec(rawUrl);
  if (directM) {
    videoId = directM[1];
  } else if (host === "v.douyin.com") {
    let location = "";
    try {
      const resp = await fetch(rawUrl, {
        headers: { "User-Agent": DY_UA },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      location = resp.headers.get("location") ?? "";
    } catch (e) {
      throw new Error(`抖音短链解析失败：${(e as Error).message}，请稍后重试`);
    }
    if (location.includes("share/user")) throw new Error("这是作者主页链接，请提供单条视频的链接");
    const idM = /(\d{15,})/.exec(location);
    if (idM) videoId = idM[1];
  }
  if (!videoId) throw new Error("无法从链接中解析抖音视频 ID，请确认是单条视频的链接");
  let html: string;
  try {
    const resp = await fetch(`https://jingxuan.douyin.com/m/video/${videoId}`, {
      headers: { "User-Agent": DY_UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    throw new Error(`抖音视频信息获取失败：${(e as Error).message}，请稍后重试或改用「粘贴文本」导入`);
  }
  const ogTitle = metaContent(html, "og:title");
  if (!ogTitle.trim()) {
    throw new Error("未能从抖音获取视频信息（视频可能不存在或已被限制），请改用「粘贴文本」导入");
  }
  const title = ogTitle.replace(/[-\u2014_\s]*\u6296\u97F3\u7CBE\u9009\s*$/, "").trim() || "抖音视频";
  const coverUrl = metaContent(html, "og:image");
  const desc = metaContent(html, "description").trim().replace(/[\uff0c,]\u4e8e[^\uff0c\u3002]{0,20}\u4e0a\u7ebf\u3002\u6296\u97f3\u7cbe\u9009[\s\S]*$/, "").trim();
  let author = "";
  let publishDate = "";
  let playCount = "";
  let diggCount = "";
  try {
    const ssrM = /window\._SSR_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
    if (ssrM) {
      const ssr = JSON.parse(ssrM[1]);
      const v = ssr?.data?.storeState?.detail?.videoData?.result;
      if (v) {
        author = v.media_user?.screen_name ?? "";
        if (v.publish_time) publishDate = new Date(Number(v.publish_time) * 1000).toISOString().slice(0, 10);
        if (v.play_count != null) playCount = String(v.play_count);
        if (v.digg_count != null) diggCount = String(v.digg_count);
      }
    }
  } catch {
  }
  const images: FeishuImage[] = [];
  const warnings: string[] = [];
  if (coverUrl) {
    try {
      const resp = await fetch(coverUrl, {
        headers: { "User-Agent": DY_UA, Referer: "https://www.douyin.com/" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const mime = (resp.headers.get("content-type") ?? "image/jpeg").split(";")[0];
      if (!mime.startsWith("image/")) throw new Error(`bad mime ${mime}`);
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("cover over 8MB");
      const { width, height } = sniffImageSize(bytes);
      images.push({
        token: "dy_cover_1",
        name: "封面.jpg",
        mime,
        width,
        height,
        dataBase64: bytes.toString("base64"),
      });
    } catch {
      warnings.push("封面图下载失败，已仅导入文字信息");
    }
  }
  const content = [
    `# ${title}`,
    "",
    `**来源**：抖音视频 · ${author || "未知"}`,
    `**发布时间**：${publishDate || "未知"}　**播放**：${playCount || "未知"}　**点赞**：${diggCount || "未知"}`,
    `**原链接**：${rawUrl}`,
    "",
    "## 视频文案",
    desc || title,
    "",
    "## 说明",
    "本素材为抖音视频元信息导入（标题/作者/数据/封面图），不含视频口播文字。如需更精准的笔记生成，请编辑本素材补充视频文案或口播稿。",
  ].join("\n");
  return { title, content, images, warnings };
}
