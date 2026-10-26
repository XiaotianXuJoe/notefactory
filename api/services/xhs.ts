/**
 * 小红书笔记导入（纯 HTTP，无需浏览器）：
 * 1. 分享文本中提取链接；xhslink.com 短链先 301 解析出带 xsec_token 的完整笔记地址
 * 2. 用移动端 UA 抓笔记页 SSR HTML：桌面 UA 访问 /explore 会被 302 到登录页，
 *    移动端 UA 会被 302 到 /discovery/item/{id}，该页匿名即可拿到完整笔记数据
 * 3. 解析 window.__INITIAL_STATE__：桌面结构 note.noteDetailMap，移动结构 noteData.data.noteData
 * 4. imageList 逐张下载（xhscdn），含文字的图片用视觉模型 OCR，文字并入素材正文
 *
 * 注意：小红书必须带 xsec_token（App 内「分享 → 复制链接」得到的链接自带）才能拿到笔记详情；
 * Cookie 从环境变量 XHS_COOKIE 或数据卷文件 /app/data/xhs_cookie.txt 读取（勿写进源码），
 * 移动端页面匿名可抓，cookie 仅作为备用/兜底。
 */
import { EnvHttpProxyAgent } from "undici";
import fs from "node:fs";
import type { FeishuImage } from "./feishu";
import { sniffImageSize } from "./wechat";
import { chatCompletionVision } from "./llm";

// 移动端 UA：桌面 UA 会被强制跳登录页，移动端可匿名拿到 /discovery/item 完整数据
const XHS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 9; // 小红书单篇最多 9 图
const xhsDispatcher = new EnvHttpProxyAgent({ connect: { family: 4, timeout: 15_000 } });

export type XhsNote = {
  title: string;
  content: string;
  images: FeishuImage[];
  warnings: string[];
  sourceUrl: string;
};

function getXhsCookie(): string {
  const env = (process.env.XHS_COOKIE ?? "").trim();
  if (env) return env;
  for (const p of ["/app/data/xhs_cookie.txt", "./data/xhs_cookie.txt"]) {
    try {
      const s = fs.readFileSync(p, "utf-8").trim();
      if (s) return s;
    } catch {
      // 文件不存在则尝试下一个路径
    }
  }
  return "";
}

/** 从分享文本/链接中解析出笔记页 URL（短链跟随一次 301 拿 xsec_token） */
async function resolveNoteUrl(raw: string): Promise<string> {
  const m = /(https?:\/\/[^\s，。"）)]+)/.exec(raw);
  if (!m) throw new Error("未在文本中找到链接，请粘贴小红书「分享 → 复制链接」得到的内容");
  let url = m[1];
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("链接格式不正确，请检查后重试");
  }
  if (host === "xhslink.com" || host.endsWith(".xhslink.com")) {
    let location = "";
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": XHS_UA },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        dispatcher: xhsDispatcher,
      } as unknown as RequestInit);
      location = resp.headers.get("location") ?? "";
    } catch (e) {
      throw new Error(`小红书短链解析失败：${(e as Error).message}，请稍后重试`);
    }
    if (!location.includes("xiaohongshu.com")) {
      throw new Error("短链未指向小红书笔记页，请确认是单篇笔记的分享链接");
    }
    url = location;
  }
  if (!/\/(explore|discovery\/item)\/[0-9a-z]{10,}/i.test(url)) {
    throw new Error("无法从链接中解析小红书笔记 ID，请确认是单篇笔记的链接（非主页/搜索页）");
  }
  return url;
}

type XhsImageInfo = {
  url?: string;
  urlDefault?: string;
  urlPre?: string;
  infoList?: { url?: string; urlScene?: string; imageScene?: string }[];
};
type XhsNoteDetail = {
  noteId?: string;
  title?: string;
  desc?: string;
  type?: string;
  time?: number;
  user?: { nickname?: string; nickName?: string };
  tagList?: { name?: string }[];
  imageList?: XhsImageInfo[];
  interactInfo?: { likedCount?: string; collectedCount?: string; commentCount?: string; shareCount?: string };
  cover?: { url?: string } | string;
  video?: { media?: { stream?: { h264?: { masterUrl?: string }[] } } };
};

/** 从 SSR HTML 提取 __INITIAL_STATE__ 并解析笔记详情（独立函数便于测试）。
 *  桌面页结构：note.noteDetailMap[id].note；移动页结构：noteData.data.noteData。 */
export function parseXhsNoteDetail(html: string): { noteId: string; note: XhsNoteDetail } {
  const m = /__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
  if (!m) throw new Error("页面结构异常（未找到笔记数据），小红书可能改版，请改用「粘贴文本」导入");
  let data: {
    note?: { noteDetailMap?: Record<string, { note?: XhsNoteDetail }> };
    noteData?: { data?: { noteData?: XhsNoteDetail } };
  };
  try {
    data = JSON.parse(m[1].replace(/\bundefined\b/g, "null"));
  } catch {
    throw new Error("笔记数据解析失败（页面格式异常），请改用「粘贴文本」导入");
  }
  // 移动页（/discovery/item）：noteData.data.noteData
  const mobileNote = data.noteData?.data?.noteData;
  if (mobileNote && (mobileNote.desc || mobileNote.title)) {
    return { noteId: mobileNote.noteId ?? "", note: mobileNote };
  }
  // 桌面页（/explore）：note.noteDetailMap
  const ndm = data.note?.noteDetailMap ?? {};
  const firstKey = Object.keys(ndm)[0];
  const note = firstKey ? ndm[firstKey]?.note : undefined;
  if (note && (note.desc || note.title)) {
    return { noteId: firstKey, note };
  }
  throw new Error(
    "未能获取笔记内容：请使用小红书 App 内「分享 → 复制链接」得到的完整分享文本（链接需带 xsec_token）。若确认链接无误仍失败，可能是小红书风控拦截，请稍后再试或改用「粘贴文本」导入",
  );
}

/** 选最优图片地址：桌面优先 infoList 的 WB_DFT（无水印大图），移动优先 H5_DTL，否则顶层 url/urlDefault */
function pickImageUrl(info: XhsImageInfo): string {
  const fromList =
    info.infoList?.find((i) => i.urlScene === "WB_DFT" && i.url)?.url ??
    info.infoList?.find((i) => i.imageScene === "H5_DTL" && i.url)?.url ??
    info.infoList?.find((i) => i.url)?.url;
  return fromList ?? info.url ?? info.urlDefault ?? info.urlPre ?? "";
}

/** 清洗正文：去掉「#话题名[话题]#」标记（话题在 tagLine 单独呈现），压缩多余空白 */
function cleanDesc(desc: string): string {
  return desc
    .replace(/#([^#\[\]]+)\[话题\]#/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const OCR_PROMPT =
  "这是一张小红书笔记配图。请逐字提取图片中的所有文字，保持原有结构（标题层级、列表、表格、代码块等）；代码用 ``` 围栏包裹；数学公式保留原文。只输出提取到的文字内容，不要描述图片、不要评论。如果图片里几乎没有文字（纯照片/装饰图），只回复两个字：无字";

export async function fetchXhsNote(shareText: string): Promise<XhsNote> {
  const url = await resolveNoteUrl(shareText);
  const cookie = getXhsCookie();

  let html: string;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": XHS_UA,
        Accept: "text/html,application/xhtml+xml",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
      dispatcher: xhsDispatcher,
    } as unknown as RequestInit);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    throw new Error(`小红书笔记访问失败：${(e as Error).message}，请稍后重试或改用「粘贴文本」导入`);
  }

  const { note } = parseXhsNoteDetail(html);
  const title = (note.title ?? "").trim() || "小红书笔记";
  const author = (note.user?.nickname ?? note.user?.nickName)?.trim() || "未知作者";
  const warnings: string[] = [];

  // 视频笔记：只导入文案 + 封面，提示不含视频内容
  const isVideo = note.type === "video";
  if (isVideo) warnings.push("这是视频笔记：已导入文案与封面，视频画面/口播内容未包含");

  // 下载图片（视频笔记无 imageList 时退而抓封面）
  const images: FeishuImage[] = [];
  let imgInfos = (note.imageList ?? []).slice(0, MAX_IMAGES);
  if (!imgInfos.length && note.cover) {
    const coverUrl = typeof note.cover === "string" ? note.cover : note.cover.url;
    if (coverUrl) imgInfos = [{ url: coverUrl }];
  }
  for (let i = 0; i < imgInfos.length; i++) {
    const imgUrl = pickImageUrl(imgInfos[i]).replace(/^http:\/\//, "https://");
    if (!imgUrl) continue;
    try {
      const resp = await fetch(imgUrl, {
        headers: { "User-Agent": XHS_UA, Referer: "https://www.xiaohongshu.com/" },
        signal: AbortSignal.timeout(30_000),
        dispatcher: xhsDispatcher,
      } as unknown as RequestInit);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const mime = (resp.headers.get("content-type") ?? "image/jpeg").split(";")[0];
      if (!mime.startsWith("image/")) throw new Error(`bad mime ${mime}`);
      const bytes = Buffer.from(await resp.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("over 8MB");
      const { width, height } = sniffImageSize(bytes);
      images.push({
        token: `xhs_${images.length + 1}`,
        name: `图片${images.length + 1}.jpg`,
        mime,
        width,
        height,
        dataBase64: bytes.toString("base64"),
      });
    } catch {
      warnings.push(`第 ${i + 1} 张图片下载失败，已跳过`);
    }
  }

  // 图片文字 OCR（视觉模型逐张提取；失败不阻断导入）
  const ocrTexts: (string | null)[] = [];
  if (images.length) {
    for (let i = 0; i < images.length; i++) {
      try {
        const text = await chatCompletionVision([`data:${images[i].mime};base64,${images[i].dataBase64}`], OCR_PROMPT, {
          maxTokens: 4096,
        });
        const trimmed = text.trim();
        ocrTexts.push(trimmed && trimmed !== "无字" && !/^无字[。！\s]*$/.test(trimmed) ? trimmed : null);
      } catch (e) {
        ocrTexts.push(null);
        warnings.push(`第 ${i + 1} 张图片文字提取失败：${(e as Error).message.slice(0, 120)}`);
      }
    }
  }

  // 组装素材正文（与抖音/公众号导入同风格）
  const tagLine = (note.tagList ?? [])
    .map((t) => t.name?.trim())
    .filter(Boolean)
    .map((n) => `#${n}`)
    .join(" ");
  const stats = note.interactInfo;
  const statsLine = stats
    ? `**数据**：❤️ ${stats.likedCount || 0} · ⭐ ${stats.collectedCount || 0} · 💬 ${stats.commentCount || 0} · ↗ ${stats.shareCount || 0}`
    : "";
  const parts: string[] = [
    `# ${title}`,
    "",
    `**来源**：小红书笔记 · ${author}`,
    `**原链接**：${url}`,
  ];
  if (statsLine) parts.push(statsLine);
  const desc = cleanDesc(note.desc ?? "") || title;
  parts.push("", desc);
  // 正文里已包含全部话题时不再重复追加话题行
  const tags = (note.tagList ?? []).map((t) => t.name?.trim()).filter(Boolean) as string[];
  if (tagLine && tags.some((t) => !desc.includes(t))) parts.push("", tagLine);
  images.forEach((img, i) => {
    parts.push("", `![图片${i + 1}](attachment://${img.token})`);
    const ocr = ocrTexts[i];
    if (ocr) parts.push("", `【图片${i + 1} 文字】`, ocr);
  });
  if (isVideo) {
    parts.push("", "## 说明", "本素材为小红书视频笔记导入（文案 + 封面），不含视频内容。如需更精准的笔记生成，请编辑本素材补充视频文案或口播稿。");
  }
  return { title, content: parts.join("\n"), images, warnings, sourceUrl: url };
}
