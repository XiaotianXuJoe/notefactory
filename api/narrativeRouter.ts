/**
 * 叙事工坊 tRPC 路由（2026-10-17 React 化重构）：
 * 数据存 MariaDB narrative_style / narrative_state 单行表（ensureSchema 建表 + 从 JSON 一次性迁移）。
 * 取代旧 narrativeRoutes.ts 的 /api/nstyle /api/nstate /api/nchat 裸 Hono 接口。
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { narrativeState, narrativeStyle } from "@db/schema";
import { getLlmConfig } from "./services/settings";
import { chatCompletion } from "./services/llm";

// ---------- 风格档案 ----------

const styleSampleSchema = z.object({ name: z.string().max(512).optional(), text: z.string().max(2500) });
const MAX_SAMPLES = 10;

type StyleDto = {
  samples: { name?: string; text: string }[];
  profile: string;
  enabled: boolean;
  prompt: string;
  updatedAt: number;
};

async function styleRead(): Promise<StyleDto> {
  const rows = await getDb().select().from(narrativeStyle).limit(1);
  const r = rows[0];
  if (!r) return { samples: [], profile: "", enabled: false, prompt: "", updatedAt: 0 };
  let samples: StyleDto["samples"] = [];
  try {
    const parsed = JSON.parse(r.samples || "[]");
    if (Array.isArray(parsed)) samples = parsed.filter((s) => s && typeof s.text === "string");
  } catch {
    // 坏数据按空处理
  }
  return {
    samples,
    profile: r.profile ?? "",
    enabled: r.enabled,
    prompt: r.prompt ?? "",
    updatedAt: r.updatedAt ? r.updatedAt.getTime() / 1000 : 0,
  };
}

async function styleWrite(d: Omit<StyleDto, "updatedAt">): Promise<void> {
  const db = getDb();
  const values = {
    samples: JSON.stringify(d.samples),
    profile: d.profile,
    enabled: d.enabled,
    prompt: d.prompt,
  };
  const rows = await db.select({ id: narrativeStyle.id }).from(narrativeStyle).limit(1);
  if (rows[0]) await db.update(narrativeStyle).set(values).where(eq(narrativeStyle.id, rows[0].id));
  else await db.insert(narrativeStyle).values(values);
}

// ---------- 工作区状态 ----------

type StateDto = {
  prompt: string;
  type: string;
  goal: string;
  topic: string;
  material: string;
  draft: Record<string, unknown> | null;
  card: Record<string, unknown> | null;
  updatedAt: number;
};

const jsonObjSchema = z.record(z.string(), z.unknown()).nullable();

async function stateRead(): Promise<StateDto> {
  const rows = await getDb().select().from(narrativeState).limit(1);
  const r = rows[0];
  if (!r) return { prompt: "", type: "", goal: "", topic: "", material: "", draft: null, card: null, updatedAt: 0 };
  const parseObj = (s: string | null): Record<string, unknown> | null => {
    if (!s) return null;
    try {
      const d = JSON.parse(s);
      return d && typeof d === "object" && !Array.isArray(d) ? d : null;
    } catch {
      return null;
    }
  };
  return {
    prompt: r.prompt ?? "",
    type: r.noteType ?? "",
    goal: r.noteGoal ?? "",
    topic: r.topic ?? "",
    material: r.material ?? "",
    draft: parseObj(r.draft),
    card: parseObj(r.card),
    updatedAt: r.updatedAt ? r.updatedAt.getTime() / 1000 : 0,
  };
}

async function stateWrite(d: Omit<StateDto, "updatedAt">): Promise<void> {
  const db = getDb();
  const values = {
    prompt: d.prompt,
    noteType: d.type,
    noteGoal: d.goal,
    topic: d.topic,
    material: d.material,
    draft: d.draft ? JSON.stringify(d.draft) : null,
    card: d.card ? JSON.stringify(d.card) : null,
  };
  const rows = await db.select({ id: narrativeState.id }).from(narrativeState).limit(1);
  if (rows[0]) await db.update(narrativeState).set(values).where(eq(narrativeState.id, rows[0].id));
  else await db.insert(narrativeState).values(values);
}

// ---------- LLM 代理限流（全局滑窗：5 分钟 60 次） ----------
const CHAT_RATE_WINDOW_MS = 5 * 60 * 1000;
const CHAT_RATE_MAX = 60;
const chatHits: number[] = [];

function chatRateLimited(): boolean {
  const now = Date.now();
  while (chatHits.length && now - chatHits[0] >= CHAT_RATE_WINDOW_MS) chatHits.shift();
  if (chatHits.length >= CHAT_RATE_MAX) return true;
  chatHits.push(now);
  return false;
}

// ---------- 路由 ----------

export const narrativeRouter = createRouter({
  style: createRouter({
    get: publicQuery.query(async () => styleRead()),
    update: publicQuery
      .input(
        z.object({
          samples: z.array(styleSampleSchema).max(MAX_SAMPLES).optional(),
          profile: z.string().max(2 * 1024 * 1024).optional(),
          enabled: z.boolean().optional(),
          prompt: z.string().max(2 * 1024 * 1024).optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const cur = await styleRead();
        const next = {
          samples: input.samples ?? cur.samples,
          profile: input.profile ?? cur.profile,
          enabled: input.enabled ?? cur.enabled,
          prompt: input.prompt ?? cur.prompt,
        };
        await styleWrite(next);
        return { ok: true };
      }),
  }),

  state: createRouter({
    get: publicQuery.query(async () => stateRead()),
    update: publicQuery
      .input(
        z.object({
          prompt: z.string().max(2 * 1024 * 1024).optional(),
          type: z.string().max(128).optional(),
          goal: z.string().max(128).optional(),
          topic: z.string().max(1024).optional(),
          material: z.string().max(2 * 1024 * 1024).optional(),
          draft: jsonObjSchema.optional(),
          card: jsonObjSchema.optional(),
        }),
      )
      .mutation(async ({ input }) => {
        const cur = await stateRead();
        const next = {
          prompt: input.prompt ?? cur.prompt,
          type: input.type ?? cur.type,
          goal: input.goal ?? cur.goal,
          topic: input.topic ?? cur.topic,
          material: input.material ?? cur.material,
          draft: input.draft === undefined ? cur.draft : input.draft,
          card: input.card === undefined ? cur.card : input.card,
        };
        await stateWrite(next);
        return { ok: true };
      }),
  }),

  /** 不含 Key 的模型配置摘要（供页面横幅展示） */
  chatConfig: publicQuery.query(async () => {
    const cfg = await getLlmConfig();
    return {
      configured: cfg.configured,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      disableThinking: cfg.disableThinking,
      temperature: cfg.temperature,
    };
  }),

  /** 统一 LLM 代理：浏览器不接触 API Key，复用主站 settings 表配置 */
  chat: publicQuery
    .input(
      z.object({
        messages: z
          .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(50000) }))
          .min(1)
          .max(30),
        maxTokens: z.number().int().min(256).max(16384).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (chatRateLimited()) throw new Error("请求过于频繁，请几分钟后再试");
      const totalChars = input.messages.reduce((s, m) => s + m.content.length, 0);
      if (totalChars > 120000) throw new Error("消息总长度超过上限");
      const text = await chatCompletion(input.messages, { maxTokens: input.maxTokens ?? 4096 });
      if (!text.trim()) throw new Error("模型返回了空内容，请重试");
      return { text };
    }),
});
