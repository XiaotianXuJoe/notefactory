import { z } from "zod";
import { sql } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { ensureSchema, getSchemaError } from "./queries/ensureSchema";
import { getSetting, setSetting, getLlmConfig } from "./services/settings";
import { getImageConfig, testImageConnection } from "./services/imagegen";
import { testLlmConnection } from "./services/llm";
import { DEFAULT_PERSONA } from "./services/prompts";
import { SETTING_KEYS, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL, DEFAULT_IMG_BASE_URL, DEFAULT_IMG_MODEL } from "@contracts/types";

/** 用裸 mysql2 分别测试明文 / TLS 连接，返回每一步的真实错误码 */
async function testRawConnections(): Promise<string[]> {
  const out: string[] = [];
  const url = process.env.DATABASE_URL ?? "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return ["✗ DATABASE_URL 解析失败"];
  }
  const base = {
    host: u.hostname,
    port: Number(u.port || 4000),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ""),
    connectTimeout: 6000,
  };
  const mysql = (await import("mysql2/promise")).default;

  for (const mode of [
    { name: "明文连接", ssl: undefined },
    { name: "TLS 连接", ssl: { rejectUnauthorized: false } as const },
  ]) {
    try {
      const conn = await mysql.createConnection({ ...base, ssl: mode.ssl });
      await conn.ping();
      await conn.end();
      out.push(`✓ ${mode.name}成功（可以连通）`);
    } catch (e) {
      const err = e as Error & { code?: string };
      out.push(`✗ ${mode.name}失败：[${err.code ?? "NO_CODE"}] ${err.message.slice(0, 150)}`);
    }
  }
  return out;
}

export const settingsRouter = createRouter({
  get: publicQuery.query(async () => {
    const [llm, img, persona, samples] = await Promise.all([
      getLlmConfig(),
      getImageConfig(),
      getSetting(SETTING_KEYS.personaPrompt),
      getSetting(SETTING_KEYS.styleSamples),
    ]);
    return {
      llmBaseUrl: llm.baseUrl || DEFAULT_LLM_BASE_URL,
      llmApiKey: llm.apiKey ? "••••••••" + llm.apiKey.slice(-4) : "",
      llmConfigured: llm.configured,
      llmModel: llm.model || DEFAULT_LLM_MODEL,
      llmDisableThinking: llm.disableThinking,
      llmTemperature: llm.temperature != null ? String(llm.temperature) : "",
      imgBaseUrl: img.baseUrl || DEFAULT_IMG_BASE_URL,
      imgApiKey: img.apiKey ? "••••••••" + img.apiKey.slice(-4) : "",
      imgConfigured: img.configured,
      imgModel: img.model || DEFAULT_IMG_MODEL,
      personaPrompt: persona ?? DEFAULT_PERSONA,
      styleSamples: samples ?? "",
    };
  }),

  update: publicQuery
    .input(
      z.object({
        llmBaseUrl: z.string().optional(),
        // 传空字符串表示保持不变；以 •••• 开头也视为未修改
        llmApiKey: z.string().optional(),
        llmModel: z.string().optional(),
        imgBaseUrl: z.string().optional(),
        imgApiKey: z.string().optional(),
        imgModel: z.string().optional(),
        personaPrompt: z.string().optional(),
        styleSamples: z.string().optional(),
        llmDisableThinking: z.boolean().optional(),
        llmTemperature: z.string().max(10).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.llmBaseUrl !== undefined) {
        await setSetting(SETTING_KEYS.llmBaseUrl, input.llmBaseUrl.trim());
      }
      if (input.llmApiKey !== undefined && input.llmApiKey.trim() !== "" && !input.llmApiKey.startsWith("••••")) {
        await setSetting(SETTING_KEYS.llmApiKey, input.llmApiKey.trim());
      }
      if (input.llmModel !== undefined) {
        await setSetting(SETTING_KEYS.llmModel, input.llmModel.trim());
      }
      if (input.imgBaseUrl !== undefined) {
        await setSetting(SETTING_KEYS.imgBaseUrl, input.imgBaseUrl.trim());
      }
      if (input.imgApiKey !== undefined && input.imgApiKey.trim() !== "" && !input.imgApiKey.startsWith("••••")) {
        await setSetting(SETTING_KEYS.imgApiKey, input.imgApiKey.trim());
      }
      if (input.imgModel !== undefined) {
        await setSetting(SETTING_KEYS.imgModel, input.imgModel.trim());
      }
      if (input.personaPrompt !== undefined) {
        await setSetting(SETTING_KEYS.personaPrompt, input.personaPrompt);
      }
      if (input.styleSamples !== undefined) {
        await setSetting(SETTING_KEYS.styleSamples, input.styleSamples);
      }
      if (input.llmDisableThinking !== undefined) {
        await setSetting(SETTING_KEYS.llmDisableThinking, input.llmDisableThinking ? "1" : "0");
      }
      if (input.llmTemperature !== undefined) {
        // 校验：空串=自动；否则必须是 0~2 的数字，非法值直接报错而不是静默存坏
        const t = input.llmTemperature.trim();
        if (t !== "" && (!/^\d*\.?\d+$/.test(t) || parseFloat(t) < 0 || parseFloat(t) > 2)) {
          throw new Error("温度必须是 0 ~ 2 之间的数字（留空 = 按模型自动）");
        }
        await setSetting(SETTING_KEYS.llmTemperature, t);
      }
      return { ok: true };
    }),

  /** 测试连接：优先用表单当前值（未保存也能测），掩码/空 Key 回落到已保存的配置 */
  testLlm: publicQuery
    .input(
      z
        .object({
          llmBaseUrl: z.string().optional(),
          llmApiKey: z.string().optional(),
          llmModel: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) =>
      testLlmConnection(
        input
          ? { baseUrl: input.llmBaseUrl, apiKey: input.llmApiKey, model: input.llmModel }
          : undefined,
      ),
    ),
  /** 测试文生图连接：优先用表单当前值（未保存也能测），掩码/空 Key 回落到已保存的配置。
   *  会真实生成一张极简测试图（1024x1024），通常 15-40 秒 */
  testImage: publicQuery
    .input(
      z
        .object({
          imgBaseUrl: z.string().optional(),
          imgApiKey: z.string().optional(),
          imgModel: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) =>
      testImageConnection(
        input
          ? { baseUrl: input.imgBaseUrl, apiKey: input.imgApiKey, model: input.imgModel }
          : undefined,
      ),
    ),
  /** 服务器出网诊断：检测运行环境能否访问指定地址（不带 Key，预期 401 = 网络通） */
  diagEgress: publicQuery
    .input(z.object({ url: z.string().url().optional() }).optional())
    .mutation(async ({ input }) => {
      const target = (input?.url ?? "https://api.moonshot.cn/v1").replace(/\/+$/, "");
      const t0 = Date.now();
      try {
        const res = await fetch(`${target}/models`, { signal: AbortSignal.timeout(15_000) });
        return {
          ok: true,
          message: `网络连通 ✓ ${target} 返回 HTTP ${res.status}（${Date.now() - t0}ms）。401/403 属正常，说明请求到达了服务器`,
        };
      } catch (e) {
        return {
          ok: false,
          message: `网络不通 ✗ ${target}：${(e as Error).name === "TimeoutError" ? "连接超时" : (e as Error).message}（${Date.now() - t0}ms）。当前运行环境可能无法访问外网`,
        };
      }
    }),

  /** 数据库诊断：建表 → 读 → 写 → 长文本写，逐步报告，定位写库失败根因 */
  diagDb: publicQuery.mutation(async () => {
    const run = async (): Promise<{ ok: boolean; message: string }> => {
      const steps: string[] = [];
      const fail = (step: string, e: unknown) => {
        const err = e as Error & { cause?: Error };
        return {
          ok: false,
          message: [
            ...steps,
            `✗ ${step} 失败：${err.message.slice(0, 200)}`,
            err.cause ? `根因：${err.cause.message.slice(0, 200)}` : "",
          ]
            .filter(Boolean)
            .join("；"),
        };
      };

      try {
        const ok = await ensureSchema();
        if (!ok) {
          const detail = getSchemaError() ?? "未知错误";
          const netTests = await testRawConnections();
          return {
            ok: false,
            message: [`✗ 建表失败，根因：${detail}`, ...netTests].join("；"),
          };
        }
        steps.push("✓ 建表成功");
      } catch (e) {
        return fail("建表", e);
      }

      try {
        const db = getDb();
        const result = await db.execute(sql`SHOW TABLES`);
        const rows = (result as unknown as [Record<string, unknown>[]])[0] ?? [];
        const names = rows.map((r) => String(Object.values(r)[0])).join(", ");
        steps.push(`✓ 当前表：${names || "（空）"}`);
      } catch (e) {
        return fail("查看表", e);
      }

      try {
        await setSetting("_diag", String(Date.now()));
        steps.push("✓ 短文本写入成功");
      } catch (e) {
        return fail("短文本写入", e);
      }

      try {
        const longText = "技术面试中的手撕代码应该如何准备？😀".repeat(50);
        await setSetting("_diag_long", longText);
        steps.push(`✓ 长文本/emoji 写入成功（${longText.length} 字）`);
      } catch (e) {
        return fail("长文本写入", e);
      }

      return { ok: true, message: steps.join("；") };
    };

    // 整体 25 秒超时，防止诊断本身挂起
    return Promise.race([
      run(),
      new Promise<{ ok: boolean; message: string }>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              message: "✗ 诊断超时（30 秒）：数据库连接挂起，请稍后重试或联系平台检查数据库网络",
            }),
          30_000,
        ),
      ),
    ]);
  }),
});
