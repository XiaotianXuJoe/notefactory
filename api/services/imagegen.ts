/**
 * 文生图服务：调用 OpenAI 兼容的 /images/generations 接口。
 * 默认对接火山引擎方舟（即梦 Seedream），用户可在设置页换成智谱 CogView 等兼容端点。
 * 生成结果转为 base64，复用 note_images 的 photo 类型存储。
 */
import { getSetting } from "./settings";
import { sniffImageSize } from "./wechat";
import { SETTING_KEYS, DEFAULT_IMG_BASE_URL, DEFAULT_IMG_MODEL, getAiStylePrompt } from "@contracts/types";

export class ImageNotConfiguredError extends Error {
  constructor() {
    super("未配置文生图 API，请到「设置」页填写图片接口信息（支持火山引擎即梦、智谱 CogView 等 OpenAI 兼容接口）");
    this.name = "ImageNotConfiguredError";
  }
}

export type ImageGenConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  configured: boolean;
};

export async function getImageConfig(): Promise<ImageGenConfig> {
  const [baseUrl, apiKey, model] = await Promise.all([
    getSetting(SETTING_KEYS.imgBaseUrl),
    getSetting(SETTING_KEYS.imgApiKey),
    getSetting(SETTING_KEYS.imgModel),
  ]);
  // 环境变量兜底（便于本地/容器直连测试）
  const key = (apiKey ?? "").trim() || (process.env.IMG_API_KEY ?? "").trim();
  return {
    baseUrl: (baseUrl ?? "").trim() || (process.env.IMG_BASE_URL ?? "").trim() || DEFAULT_IMG_BASE_URL,
    apiKey: key,
    model: (model ?? "").trim() || (process.env.IMG_MODEL ?? "").trim() || DEFAULT_IMG_MODEL,
    configured: key.length > 0,
  };
}

export type GeneratedPhoto = {
  mime: string;
  dataBase64: string;
  width: number;
  height: number;
  finalPrompt: string;
};

function mimeFromBytes(buf: Buffer): string {
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF") return "image/webp";
  if (buf.length > 3 && buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  return "image/png";
}

const TIMEOUT_MS = 120_000; // 异步生成模式下不受 60 秒网关限制；大图实测需 40-60 秒

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error(`文生图接口超过 ${TIMEOUT_MS / 1000} 秒未返回，请直接重试`);
    }
    throw new Error(`无法连接文生图接口：${err.message}，请检查设置页的图片 Base URL`);
  }
}

export type AiImageMode = "illustration" | "infographic";

/** 生成一张小红书配图（竖版 3:4）。userPrompt 为用户输入的画面描述；styleId 为笔记级统一画风 */
export async function generateAiImage(
  userPrompt: string,
  mode: AiImageMode = "illustration",
  styleId?: string | null,
): Promise<GeneratedPhoto> {
  const cfg = await getImageConfig();
  if (!cfg.apiKey) throw new ImageNotConfiguredError();
  const stylePrompt = getAiStylePrompt(styleId);

  // 氛围插画默认禁文字（AI 汉字易翻车）；信息图模式则要求严格渲染给定文字（路线 B）
  let finalPrompt: string;
  if (mode === "infographic") {
    finalPrompt =
      `小红书知识卡片风格信息图，竖版 3:4，浅色干净背景，分区排版，配少量装饰小图标。整体画风：${stylePrompt}。内容如下：${userPrompt.trim()}。` +
      `图中的所有文字必须严格按描述中的原文渲染，一个字都不能改、不能增删。`;
  } else {
    const wantsText = /文字|标题|大字|文案|标语|slogan/i.test(userPrompt);
    finalPrompt =
      `小红书笔记配图，竖版 3:4 构图。画面描述：${userPrompt.trim()}。` +
      `风格：${stylePrompt}，适合编程学习类账号。` +
      (wantsText ? "" : "画面中不要出现任何文字、字母、数字和水印。");
  }

  // 用户可能填基础地址（…/v1）也可能填完整端点（…/v1/images/generations），都做兼容
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const url = /\/images\/generations$/i.test(base) ? base : `${base}/images/generations`;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };

  // 依次降级：3:4 精确尺寸 → 通用 "2K"（部分端点只认档位）→ 去掉 response_format（只返 URL 的端点）
  // 注：尺寸不要贪大，实测第三方网关上 1728x2304 需 55 秒+，会顶到 60 秒平台超时
  const attempts: Record<string, unknown>[] = [
    { model: cfg.model, prompt: finalPrompt, size: "1024x1360", response_format: "b64_json" },
    { model: cfg.model, prompt: finalPrompt, size: "2K", response_format: "b64_json" },
    { model: cfg.model, prompt: finalPrompt },
  ];

  let res: Response | null = null;
  let payloadUsed = attempts[0];
  for (let i = 0; i < attempts.length; i++) {
    const r = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(attempts[i]) });
    if (r.status === 400 && i < attempts.length - 1) {
      const text = await r.clone().text().catch(() => "");
      // 参数不兼容（size/response_format 不被支持）时尝试下一组
      if (/size|response_format|param/i.test(text)) continue;
    }
    res = r;
    payloadUsed = attempts[i];
    break;
  }
  if (!res) throw new Error("文生图接口调用失败");

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error("图片 API Key 无效（401/403），请到「设置」页检查文生图 API 的 Key 与 Base URL 是否属于同一平台");
    }
    if (res.status === 429) {
      throw new Error(`图片接口额度/限流问题（HTTP 429）：${text.slice(0, 150)}`);
    }
    if (res.status === 404) {
      throw new Error(`图片接口或模型不存在（404）：请确认 Base URL 和图片模型名（当前：${cfg.model}）`);
    }
    throw new Error(`文生图失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }

  type ImgResp = { data?: { b64_json?: string; url?: string }[] };
  const data = (await res.json().catch(() => {
    throw new Error("图片接口返回了非 JSON 内容：请检查 Base URL 是否正确，或上游网关是否异常");
  })) as ImgResp;
  const first = data.data?.[0];

  let bytes: Buffer | null = null;
  if (first?.b64_json) {
    bytes = Buffer.from(first.b64_json, "base64");
  } else if (first?.url) {
    const imgRes = await fetchWithTimeout(first.url, { method: "GET" });
    if (!imgRes.ok) throw new Error(`图片已生成但下载失败（HTTP ${imgRes.status}），请重试`);
    bytes = Buffer.from(await imgRes.arrayBuffer());
  }
  if (!bytes || bytes.length < 1000) {
    throw new Error(`文生图接口返回为空（请求参数：${JSON.stringify(payloadUsed).slice(0, 120)}…），请检查图片模型名是否正确`);
  }

  const { width, height } = sniffImageSize(bytes);
  return {
    mime: mimeFromBytes(bytes),
    dataBase64: bytes.toString("base64"),
    width,
    height,
    finalPrompt,
  };
}

export type ImageGenOverride = { baseUrl?: string; apiKey?: string; model?: string };

/** 测试文生图配置：真实调一次接口生成极简测试图，验证 Key/模型/参数全链路。
 *  override 优先（表单未保存也能测）；掩码（••••）/空 Key 回落到已保存的配置。 */
export async function testImageConnection(
  override?: ImageGenOverride,
): Promise<{ ok: boolean; message: string }> {
  try {
    const saved = await getImageConfig();
    const cleaned = override
      ? {
          baseUrl: override.baseUrl?.trim() || undefined,
          model: override.model?.trim() || undefined,
          apiKey:
            override.apiKey && override.apiKey.trim() !== "" && !override.apiKey.startsWith("••••")
              ? override.apiKey.trim()
              : undefined,
        }
      : undefined;
    const cfg = {
      baseUrl: cleaned?.baseUrl ?? saved.baseUrl,
      apiKey: cleaned?.apiKey ?? saved.apiKey,
      model: cleaned?.model ?? saved.model,
    };
    if (!cfg.apiKey) return { ok: false, message: "未填写 API Key，且没有已保存的 Key 可用" };

    const base = cfg.baseUrl.replace(/\/+$/, "");
    const url = /\/images\/generations$/i.test(base) ? base : `${base}/images/generations`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` };
    const prompt = "一个红色圆形小图标，纯白背景，极简扁平风格";
    // 小尺寸测试图更快更省；部分端点不认 size/response_format 时降级重试
    const attempts: Record<string, unknown>[] = [
      { model: cfg.model, prompt, size: "1024x1024", response_format: "b64_json" },
      { model: cfg.model, prompt },
    ];

    const t0 = Date.now();
    let res: Response | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const r = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(attempts[i]) });
      if (r.status === 400 && i < attempts.length - 1) {
        const text = await r.clone().text().catch(() => "");
        if (/size|response_format|param/i.test(text)) continue;
      }
      res = r;
      break;
    }
    if (!res) return { ok: false, message: "文生图接口调用失败，请重试" };
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        return { ok: false, message: `Key 无效（HTTP ${res.status}）：请检查 Key 与 Base URL 是否属于同一平台` };
      }
      if (res.status === 404) {
        return { ok: false, message: `接口或模型不存在（404）：请确认 Base URL 和图片模型名（当前：${cfg.model}）` };
      }
      if (res.status === 429) {
        return { ok: false, message: `额度/限流问题（HTTP 429）：${text.slice(0, 120)}` };
      }
      return { ok: false, message: `请求失败（HTTP ${res.status}）：${text.slice(0, 200)}` };
    }
    type ImgResp = { data?: { b64_json?: string; url?: string }[] };
    const data = (await res.json().catch(() => null)) as ImgResp | null;
    if (!data) return { ok: false, message: "接口返回了非 JSON 内容：请检查 Base URL 是否正确" };
    const first = data.data?.[0];
    if (!first?.b64_json && !first?.url) {
      return { ok: false, message: "接口返回为空：请检查图片模型名是否正确" };
    }
    const kb = first.b64_json ? Math.round((first.b64_json.length * 3) / 4 / 1024) : 0;
    return { ok: true, message: `连接成功 ✓ 模型 ${cfg.model} 已返回测试图${kb ? `（${kb}KB）` : ""}，耗时 ${elapsed}s` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
