/**
 * OpenAI 兼容的 LLM 客户端。
 * 默认对接 Moonshot（https://api.moonshot.cn/v1），用户在设置页可换成任何兼容端点。
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { getLlmConfig } from "./settings";

// 运行环境若提供 HTTP(S)_PROXY，fetch 走代理出网（无代理变量时直连，行为不变）
try {
  setGlobalDispatcher(new EnvHttpProxyAgent());
} catch {
  // 忽略：极端环境下代理初始化失败则保持默认直连
}

export class OutputTruncatedError extends Error {
  constructor() {
    super("模型输出被截断（finish_reason=length）");
    this.name = "OutputTruncatedError";
  }
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("未配置 LLM API Key，请到「设置」页填写（支持 Moonshot 等 OpenAI 兼容接口）");
    this.name = "LlmNotConfiguredError";
  }
}

export type LlmOverride = { baseUrl?: string; apiKey?: string; model?: string };

export async function chatCompletion(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; override?: LlmOverride } = {},
): Promise<string> {
  const saved = await getLlmConfig();
  const cfg = {
    baseUrl: (opts.override?.baseUrl ?? "").trim() || saved.baseUrl,
    apiKey: (opts.override?.apiKey ?? "").trim() || saved.apiKey,
    model: (opts.override?.model ?? "").trim() || saved.model,
    disableThinking: saved.disableThinking,
    temperature: saved.temperature,
  };
  if (!cfg.apiKey) throw new LlmNotConfiguredError();

  const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const timeoutMs =
    opts.timeoutMs ?? (opts.maxTokens !== undefined && opts.maxTokens <= 3000 ? 60_000 : 180_000);

  // kimi k2/k3 思考模型默认推理档较高，推理过程会吃掉大量 token、还容易超时；
  // 内容生成场景用 low 档即可。仅对 k2/k3 系列发送该字段，400 时自动降级去掉重试。
  const wantsEffort = /(^|[-/])k[23]($|[-/.])/i.test(cfg.model) || /kimi-k[23]/i.test(cfg.model);
  // 用户在设置里开了「关闭模型思考」：k2.x/k3 发送 reasoning_effort:"none" 彻底关掉推理，速度显著提升；
  // 端点不支持该取值时走既有的 400 自动回退（去掉该字段），不影响使用。
  const noThink = cfg.disableThinking && wantsEffort;

  // 温度策略（用户定的规则 + 端点限制）：
  // - 优先级：设置页用户输入 > 硬性规则 > 单次调用 opts.temperature
  // - 硬性规则：关闭思考的 k2.x 必须 0.6；思考模型（k2.x/k3）只允许 1 → 直接发对，省一次 400 重试；
  //   其余模型用单次调用值，都没有则不传 temperature。400 时仍有自动降级重试兜底。
  const autoTemp =
    noThink && (/(^|[-/])k2($|[-/.])/i.test(cfg.model) || /kimi-k2/i.test(cfg.model))
      ? 0.6
      : wantsEffort
        ? 1
        : undefined;
  const tempToSend = cfg.temperature ?? autoTemp ?? opts.temperature;

  const buildBody = (withTemperature: boolean, withEffort: boolean, maxTok: number) =>
    JSON.stringify({
      model: cfg.model,
      messages,
      ...(withTemperature ? { temperature: tempToSend ?? 0.7 } : {}),
      ...(withEffort ? { reasoning_effort: noThink ? "none" : "low" } : {}),
      max_tokens: maxTok,
    });

  const doFetch = async (withTemperature: boolean, withEffort: boolean, maxTok: number): Promise<Response> => {
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: buildBody(withTemperature, withEffort, maxTok),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw Object.assign(
          new Error(`请求 LLM 超过 ${timeoutMs / 1000} 秒未返回：可能是网络不通，也可能是本次生成内容过多。请检查 Base URL 是否正确，或稍后重试`),
          { retryable: true }
        );
      }
      throw new Error(
        `无法连接 ${cfg.baseUrl}：${err.message}。请检查 Base URL 拼写及网络连通性`,
      );
    }
  };

  const runOnce = async (maxTok: number): Promise<string> => {
    let res = await doFetch(tempToSend !== undefined, wantsEffort, maxTok);
    if (res.status === 400) {
      const text = await res.clone().text().catch(() => "");
      if (wantsEffort && /reasoning_effort/i.test(text)) {
        // 该端点不识别 reasoning_effort（如第三方代理），去掉后重试
        res = await doFetch(false, false, maxTok);
      } else if (/temperature/i.test(text)) {
        // 模型对 temperature 有硬性限制，带上 temperature=1 重试
        res = await doFetch(true, wantsEffort, maxTok);
        if (res.status === 400) {
          const t2 = await res.clone().text().catch(() => "");
          if (wantsEffort && /reasoning_effort/i.test(t2)) {
            res = await doFetch(true, false, maxTok);
          } else if (/temperature/i.test(t2)) {
            // 仍失败：尝试 temperature=1 精确值
            res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${cfg.apiKey}`,
              },
              body: JSON.stringify({
                model: cfg.model,
                messages,
                temperature: 1,
                max_tokens: maxTok,
              }),
              signal: AbortSignal.timeout(timeoutMs),
            });
          }
        }
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new Error(
          "API Key 无效（401）。注意：kimi.com 的 Kimi Code Key 和 platform.moonshot.cn 开放平台的 Key 是两套体系，不能混用——前者 Base URL 应填 https://api.kimi.com/coding/v1，后者填 https://api.moonshot.cn/v1",
        );
      }
      if (res.status === 402) {
        throw new Error(
          `账户额度问题（HTTP 402）：${text.slice(0, 200)}——请到 platform.moonshot.cn 检查账户余额/套餐状态`,
        );
      }
      if (res.status === 429) {
        throw Object.assign(
          new Error("请求过于频繁（HTTP 429），自动重试中"),
          { status: 429 }
        );
      }
      if (res.status === 500 || res.status === 502 || res.status === 503) {
        throw Object.assign(
          new Error(`LLM 调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`),
          { status: res.status }
        );
      }
      if (res.status === 404) {
        throw new Error(
          `接口地址或模型名不存在（404）：请确认 Base URL 以 /v1 结尾、模型名（当前：${cfg.model}）在该平台可用`,
        );
      }
      throw new Error(`LLM 调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      if (choice?.finish_reason === "length") {
        throw new OutputTruncatedError();
      }
      throw new Error("LLM 返回内容为空");
    }

    return content;
  };

  // 429/5xx/超时自动重试（退避 1s、3s），其余错误直接抛出
  const runWithRetry = async (maxTok: number): Promise<string> => {
    const delays = [1000, 3000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await runOnce(maxTok);
      } catch (e) {
        const err = e as Error & { retryable?: boolean; status?: number };
        const retryable =
          err.retryable === true || err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503;
        if (!retryable || attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  };

  try {
    return await runWithRetry(opts.maxTokens ?? 4096);
  } catch (e) {
    if (e instanceof OutputTruncatedError) {
      // 思考模型的推理过程会占用大量 token：自动用 3 倍 max_tokens 重试一次
      try {
        return await runWithRetry(Math.max((opts.maxTokens ?? 4096) * 3, 16384));
      } catch (e2) {
        if (e2 instanceof OutputTruncatedError) {
          throw new Error(
            "模型输出仍被截断：当前是思考模型，推理占用了过多 token。已自动加大 max_tokens 重试仍不够，建议在设置页换用非思考模型（如 kimi-k2.5），或稍后重试",
          );
        }
        throw e2;
      }
    }
    throw e;
  }
}

/** 多模态消息内容分片（OpenAI 兼容视觉请求） */
export type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * 视觉理解调用（图片 OCR / 内容分析）。
 * 使用 OpenAI 兼容的多模态消息格式（content 为 part 数组，图片走 base64 data URL）。
 * 配置的模型不支持图片输入（400 且报错提及 image/vision）时，自动回退到 kimi-latest 重试一次。
 */
export async function chatCompletionVision(
  imageDataUrls: string[],
  prompt: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const saved = await getLlmConfig();
  if (!saved.apiKey) throw new LlmNotConfiguredError();
  const url = saved.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const maxTok = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const content: VisionContentPart[] = [
    ...imageDataUrls.map((u) => ({ type: "image_url" as const, image_url: { url: u } })),
    { type: "text", text: prompt },
  ];
  const doPost = (model: string) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${saved.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: maxTok }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const runOnce = async (): Promise<string> => {
    let res: Response;
    try {
      res = await doPost(saved.model);
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw Object.assign(new Error(`请求视觉模型超过 ${timeoutMs / 1000} 秒未返回，请稍后重试`), {
          retryable: true,
        });
      }
      throw new Error(`无法连接 ${saved.baseUrl}：${err.message}。请检查 Base URL 拼写及网络连通性`);
    }
    if (res.status === 400) {
      const text = await res.clone().text().catch(() => "");
      if (/image|vision|multimodal/i.test(text) && saved.model !== "kimi-latest") {
        // 配置的模型不接受图片输入：回退到 Moonshot 视觉模型
        res = await doPost("kimi-latest");
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new Error("API Key 无效（401），请到「设置」页检查 LLM 配置");
      }
      if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503) {
        throw Object.assign(new Error(`视觉模型调用失败（HTTP ${res.status}）：${text.slice(0, 200)}`), {
          status: res.status,
        });
      }
      throw new Error(`视觉模型调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const out = data.choices?.[0]?.message?.content;
    if (!out) throw new Error("视觉模型返回内容为空");
    return out;
  };

  // 429/5xx 重试一次（2s 退避）
  try {
    return await runOnce();
  } catch (e) {
    const err = e as Error & { retryable?: boolean; status?: number };
    const retryable = err.retryable === true || err.status === 429 || err.status === 500 || err.status === 502 || err.status === 503;
    if (!retryable) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    return await runOnce();
  }
}

/** 从 LLM 输出中提取 JSON（容忍 ```json 围栏、前后杂文本、字符串内的裸换行） */
export function extractJson<T>(raw: string): T {
  let s = raw.trim();
  // 注意：不能用 ``` 围栏截取——正文字符串里可能内嵌代码块，会把 JSON 截断。
  // 直接定位首个 { 和最后一个 } 之间的区间即可。
  const start = s.search(/[[{]/);
  const end = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  try {
    return JSON.parse(s) as T;
  } catch {
    // 修复字符串内的未转义控制字符（LLM 常见问题：正文换行直接写进 JSON 字符串）
    const repaired: string[] = [];
    let inString = false;
    let escaped = false;
    for (const ch of s) {
      if (escaped) {
        repaired.push(ch);
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        repaired.push(ch);
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        repaired.push(ch);
        continue;
      }
      if (inString && (ch === "\n" || ch === "\r" || ch === "\t")) {
        repaired.push(ch === "\t" ? "\\t" : "\\n");
        continue;
      }
      repaired.push(ch);
    }
    return JSON.parse(repaired.join("")) as T;
  }
}

/** 测试 LLM 连通性；传入 override 时优先用表单里的值（掩码 Key 自动回落到已保存的 Key） */
export async function testLlmConnection(
  override?: LlmOverride,
): Promise<{ ok: boolean; message: string }> {
  try {
    const cleaned: LlmOverride | undefined = override
      ? {
          baseUrl: override.baseUrl?.trim() || undefined,
          model: override.model?.trim() || undefined,
          apiKey:
            override.apiKey && override.apiKey.trim() !== "" && !override.apiKey.startsWith("••••")
              ? override.apiKey.trim()
              : undefined,
        }
      : undefined;
    const out = await chatCompletion(
      [{ role: "user", content: "只回复两个字：正常" }],
      { maxTokens: 2000, temperature: 0, override: cleaned },
    );
    return { ok: true, message: `连接成功，模型回复：${out.slice(0, 20)}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
