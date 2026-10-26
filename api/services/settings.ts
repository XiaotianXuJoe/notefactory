import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { settings } from "@db/schema";
import { SETTING_KEYS, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from "@contracts/types";

export async function getSetting(key: string): Promise<string | null> {
  try {
    const rows = await getDb()
      .select()
      .from(settings)
      .where(eq(settings.skey, key))
      .limit(1);
    return rows[0]?.svalue ?? null;
  } catch (e) {
    console.warn(`[settings] 读取 ${key} 失败：`, (e as Error).message);
    return null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb()
    .insert(settings)
    .values({ skey: key, svalue: value })
    .onDuplicateKeyUpdate({ set: { svalue: value } });
}

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  configured: boolean;
  disableThinking: boolean; // 关闭思考模式（reasoning_effort: none）
  temperature: number | null; // 用户显式设置的温度；null=按模型自动
};

export async function getLlmConfig(): Promise<LlmConfig> {
  const [baseUrl, apiKey, model, disableThinking, temperature] = await Promise.all([
    getSetting(SETTING_KEYS.llmBaseUrl),
    getSetting(SETTING_KEYS.llmApiKey),
    getSetting(SETTING_KEYS.llmModel),
    getSetting(SETTING_KEYS.llmDisableThinking),
    getSetting(SETTING_KEYS.llmTemperature),
  ]);
  const key = (apiKey ?? "").trim();
  const t = parseFloat((temperature ?? "").trim());
  return {
    baseUrl: (baseUrl ?? "").trim() || DEFAULT_LLM_BASE_URL,
    apiKey: key,
    model: (model ?? "").trim() || DEFAULT_LLM_MODEL,
    configured: key.length > 0,
    disableThinking: (disableThinking ?? "").trim() === "1",
    temperature: Number.isFinite(t) && t >= 0 && t <= 2 ? t : null,
  };
}
