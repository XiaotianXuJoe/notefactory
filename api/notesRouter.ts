import { z } from "zod";
import { asc, desc, eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { materials, materialImages, noteImages, noteSyncImages, notes } from "@db/schema";
import { chunkCodeCards, chunkProblemCards, chunkProblemCardsTo, generateImagePlans, generateImageSpec, generateNote, refineImagePrompt, regenerateTitles, rewriteBody, runQc } from "./services/pipeline";
import { generateAiImage } from "./services/imagegen";
import { chatCompletion, extractJson } from "./services/llm";
import { buildImageEditPrompt } from "./services/prompts";
import type { ImageSpec, NoteImageSpec, PhotoSpec } from "@contracts/types";
import { SETTING_KEYS } from "@contracts/types";
import { getSetting, setSetting } from "./services/settings";
import { randomBytes } from "node:crypto";

/** JSON 解析兜底：脏数据（写入中断/历史格式）不再让接口 500 */
/** 本地应用 AI 微调输出的 textPatches：find 为原文逐字片段，replace 为新文字；找不到的补丁跳过 */
function applyTextPatches(orig: string, patches: unknown): string {
  if (!Array.isArray(patches)) return orig;
  let text = orig;
  for (const p of patches) {
    const find = typeof (p as { find?: unknown })?.find === "string" ? (p as { find: string }).find : "";
    const replace = typeof (p as { replace?: unknown })?.replace === "string" ? (p as { replace: string }).replace : "";
    if (!find) continue;
    const i = text.indexOf(find);
    if (i >= 0) text = text.slice(0, i) + replace + text.slice(i + find.length);
  }
  return text;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 校验同步服务令牌；未配置时自动生成一个持久化 token */
async function requireSyncToken(token: string): Promise<void> {
  const saved = await getSetting(SETTING_KEYS.xhsSyncToken);
  if (!saved) throw new Error("网站尚未生成同步令牌，请先在笔记编辑器点一次「同步到草稿箱」旁的信息查看");
  if (token !== saved) throw new Error("同步令牌不正确");
}

const imageKindSchema = z.enum(["cover", "steps", "code", "problem", "quote", "list", "compare", "diagram", "end"]);

const imageSpecSchema = z.object({
  kind: imageKindSchema,
  title: z.string().optional().default(""),
  tag: z.string().optional(),
  subtitle: z.string().optional(),
  steps: z.array(z.object({ t: z.string(), d: z.string() })).optional(),
  lang: z.string().optional(),
  code: z.string().optional(),
  note: z.string().optional(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
  quote: z.string().optional(),
  sub: z.string().optional(),
  items: z.array(z.string()).optional(),
  leftLabel: z.string().optional(),
  leftPoints: z.array(z.string()).optional(),
  rightLabel: z.string().optional(),
  rightPoints: z.array(z.string()).optional(),
  lines: z.array(z.string()).optional(),
  cta: z.string().optional(),
  mermaid: z.string().optional(),
  theme: z.enum(["orange", "blue", "dark", "green"]),
  lineGap: z.number().optional(),
  paraGap: z.number().optional(),
  fontSize: z.number().optional(),
});

async function getNoteOrThrow(id: number) {
  const rows = await getDb().select().from(notes).where(eq(notes.id, id)).limit(1);
  if (!rows[0]) throw new Error("笔记不存在");
  return rows[0];
}

/** 把一篇笔记的某类分页卡（代码卡/题目描述卡）合并回一个完整 spec（去掉分页序号和行号偏移），用于合集级编辑 */
async function mergeImageGroup(noteId: number, kind: "code" | "problem") {
  const rows = await getDb()
    .select()
    .from(noteImages)
    .where(eq(noteImages.noteId, noteId))
    .orderBy(asc(noteImages.sortOrder));
  const groupRows = rows.filter((r) => r.kind === kind);
  if (groupRows.length === 0) return null;
  const specs = groupRows.map(
    (r) => safeJsonParse(r.spec, {} as { title: string; code?: string; text?: string; lineOffset?: number; truncated?: boolean }),
  );
  const base: Record<string, unknown> = { ...specs[0], title: specs[0].title.replace(/（\d+\/\d+）$/, "") };
  delete base.lineOffset;
  delete base.truncated;
  const merged = (
    kind === "code"
      ? { ...base, code: specs.map((sp) => sp.code ?? "").join("\n") }
      : { ...base, text: specs.map((sp) => sp.text ?? "").join("\n\n") }
  ) as unknown as CodeSpecLike | ProblemSpecLike;
  return { groupRows, merged };
}

/** 用新的完整 spec 重建该笔记的所有分页卡（重新分页），其余配图不动 */
async function replaceImageGroup(
  noteId: number,
  kind: "code" | "problem",
  groupRows: { id: number; sortOrder: number }[],
  spec: CodeSpecLike | ProblemSpecLike,
  lastPrompt?: string,
  targetPages?: number,
) {
  const chunks =
    kind === "code"
      ? chunkCodeCards(spec as CodeSpecLike, targetPages)
      : targetPages
        ? chunkProblemCardsTo(spec as ProblemSpecLike, targetPages)
        : chunkProblemCards(spec as ProblemSpecLike);
  const baseOrder = Math.min(...groupRows.map((r) => r.sortOrder));
  for (const row of groupRows) {
    await getDb().delete(noteImages).where(eq(noteImages.id, row.id));
  }
  for (let i = 0; i < chunks.length; i++) {
    await getDb().insert(noteImages).values({
      noteId,
      kind,
      spec: JSON.stringify(chunks[i]),
      sortOrder: baseOrder + i,
      ...(lastPrompt ? { lastPrompt } : {}),
    });
  }
  return chunks.length;
}

/** 后台执行文生图，完成后改写占位行；失败把错误写进 spec 供前端展示和重试 */
async function runAiImageJob(imageId: number, prompt: string, mode: "illustration" | "infographic"): Promise<void> {
  try {
    // 执行时读笔记当前画风：生成途中用户改画风也能生效
    const imgRows = await getDb().select().from(noteImages).where(eq(noteImages.id, imageId)).limit(1);
    if (!imgRows[0]) return;
    const noteRows = await getDb().select().from(notes).where(eq(notes.id, imgRows[0].noteId)).limit(1);
    const photo = await generateAiImage(prompt, mode, noteRows[0]?.aiStyle);
    const rows = await getDb().select().from(noteImages).where(eq(noteImages.id, imageId)).limit(1);
    if (!rows[0]) return; // 行已被删除
    const spec = safeJsonParse(rows[0].spec, {} as PhotoSpec);
    const next: PhotoSpec = {
      ...spec,
      width: photo.width,
      height: photo.height,
      dataUrl: `data:${photo.mime};base64,${photo.dataBase64}`,
      generating: false,
      error: undefined,
    };
    await getDb().update(noteImages).set({ spec: JSON.stringify(next) }).where(eq(noteImages.id, imageId));
  } catch (e) {
    try {
      const rows = await getDb().select().from(noteImages).where(eq(noteImages.id, imageId)).limit(1);
      if (!rows[0]) return;
      const spec = safeJsonParse(rows[0].spec, {} as PhotoSpec);
      const next: PhotoSpec = { ...spec, generating: false, error: (e as Error).message.slice(0, 300) };
      await getDb().update(noteImages).set({ spec: JSON.stringify(next) }).where(eq(noteImages.id, imageId));
    } catch (e2) {
      console.error("[runAiImageJob] 写回失败状态失败：", (e2 as Error).message);
    }
  }
}

export const notesRouter = createRouter({
  list: publicQuery.query(async () => {
    const rows = await getDb().select().from(notes).orderBy(desc(notes.createdAt));
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      isDemo: r.isDemo,
      tags: safeJsonParse<string[]>(r.tags, []),
      bodyPreview: r.body.slice(0, 80),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }),

  get: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const note = await getNoteOrThrow(input.id);
    const images = await getDb()
      .select()
      .from(noteImages)
      .where(eq(noteImages.noteId, input.id))
      .orderBy(asc(noteImages.sortOrder));
    return {
      ...note,
      titleCandidates: safeJsonParse<string[]>(note.titleCandidates, []),
      tags: safeJsonParse<string[]>(note.tags, []),
      qcReport: safeJsonParse<QcItemLike[]>(note.qcReport, []),
      images: images.map((img) => ({
        id: img.id,
        kind: img.kind,
        spec: safeJsonParse(img.spec, {} as NoteImageSpec),
        sortOrder: img.sortOrder,
        version: img.version,
        lastPrompt: img.lastPrompt,
      })),
    };
  }),

  /** 从素材生成笔记（配图类型可选） */
  generate: publicQuery
    .input(
      z.object({
        materialId: z.number(),
        noteType: z.string().optional(),
        instruction: z.string().max(500).optional(),
        imageKinds: z.array(imageKindSchema).max(7).optional(),
        skeleton: z.string().max(6000).optional(),
        angle: z.string().max(300).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const mat = await getDb().select().from(materials).where(eq(materials.id, input.materialId)).limit(1);
      if (!mat[0]) throw new Error("素材不存在");

      const gen = await generateNote(mat[0].title, mat[0].content, {
        noteType: input.noteType,
        instruction: input.instruction,
        imageKinds: input.imageKinds,
        skeleton: input.skeleton,
        angle: input.angle,
      });
      const title = (gen.titles[0] ?? mat[0].title).slice(0, 255); // varchar(255) 兜底，防 LLM 超长标题导致插入失败
      const qc = runQc({ title, body: gen.body, tags: gen.tags });

      const inserted = await getDb().insert(notes).values({
        materialId: input.materialId,
        title,
        titleCandidates: JSON.stringify(gen.titles),
        body: gen.body,
        tags: JSON.stringify(gen.tags),
        qcReport: JSON.stringify(qc),
        isDemo: gen.isDemo,
      });
      const noteId = Number(inserted[0].insertId);

      if (gen.images.length) {
        await getDb().insert(noteImages).values(
          gen.images.map((img, i) => ({
            noteId,
            kind: img.kind,
            spec: JSON.stringify(img.spec),
            sortOrder: i,
          })),
        );
      }
      return { id: noteId, isDemo: gen.isDemo, demoNote: gen.demoNote ?? null };
    }),

  /** 按用户指令用 AI 改写正文（只返回改写结果，由前端确认后保存） */
  rewriteBody: publicQuery
    .input(z.object({ id: z.number(), instruction: z.string().min(1).max(500), currentBody: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const note = await getNoteOrThrow(input.id);
      const body = await rewriteBody(note.title, input.currentBody, input.instruction);
      return { body };
    }),

  /** 为已有笔记追加一张指定类型的配图 */
  addImage: publicQuery
    .input(z.object({ noteId: z.number(), kind: imageKindSchema, prompt: z.string().max(300).optional() }))
    .mutation(async ({ input }) => {
      const note = await getNoteOrThrow(input.noteId);
      // 题目描述卡/代码卡需要素材原文做本地长文本提取（避免 LLM 复述截断）
      const matRows = note.materialId
        ? await getDb().select().from(materials).where(eq(materials.id, note.materialId))
        : [];
      const spec = await generateImageSpec(input.kind, note.title, note.body, input.prompt, matRows[0]?.content);
      // 笔记设置了统一配色时，新模板图直接套用
      if (note.svgTheme && spec && typeof spec === "object" && "theme" in spec) {
        (spec as { theme: string }).theme = note.svgTheme;
      }
      const existing = await getDb().select().from(noteImages).where(eq(noteImages.noteId, input.noteId));
      // 代码过长自动分页成多张代码卡
      const specs =
        input.kind === "code"
          ? chunkCodeCards(spec as CodeSpecLike)
          : input.kind === "problem"
            ? chunkProblemCards(spec as ProblemSpecLike)
            : [spec];
      for (let i = 0; i < specs.length; i++) {
        await getDb().insert(noteImages).values({
          noteId: input.noteId,
          kind: input.kind,
          spec: JSON.stringify(specs[i]),
          sortOrder: existing.length + i,
        });
      }
      return { ok: true, kind: input.kind, added: specs.length };
    }),

  /** 把素材原图（飞书/公众号文章中的图片）直接加为笔记配图 */
  addMaterialImage: publicQuery
    .input(z.object({ noteId: z.number(), materialImageId: z.number() }))
    .mutation(async ({ input }) => {
      await getNoteOrThrow(input.noteId);
      const rows = await getDb()
        .select()
        .from(materialImages)
        .where(eq(materialImages.id, input.materialImageId))
        .limit(1);
      const mi = rows[0];
      if (!mi) throw new Error("素材图片不存在");
      const spec: PhotoSpec = {
        kind: "photo",
        title: "",
        name: mi.name || "素材图片",
        width: mi.width,
        height: mi.height,
        dataUrl: `data:${mi.mime};base64,${mi.dataBase64}`,
        source: "material",
      };
      const existing = await getDb().select().from(noteImages).where(eq(noteImages.noteId, input.noteId));
      await getDb().insert(noteImages).values({
        noteId: input.noteId,
        kind: "photo",
        spec: JSON.stringify(spec),
        sortOrder: existing.length,
      });
      return { ok: true };
    }),

  /** 路线 A：LLM 读原始素材全文（信息比改写后的笔记更全），产出 AI 生图画面方案（3 选 1） */
  imagePlans: publicQuery
    .input(z.object({ noteId: z.number(), mode: z.enum(["illustration", "infographic"]) }))
    .mutation(async ({ input }) => {
      const note = await getNoteOrThrow(input.noteId);
      // 优先使用原素材内容生成方案；笔记未关联素材时退回笔记标题+正文
      let srcTitle = note.title;
      let srcContent = note.body;
      if (note.materialId != null) {
        const rows = await getDb()
          .select()
          .from(materials)
          .where(eq(materials.id, note.materialId))
          .limit(1);
        const mat = rows[0];
        if (mat?.content) {
          srcTitle = mat.title || srcTitle;
          srcContent = mat.content;
        }
      }
      const plans = await generateImagePlans(srcTitle, srcContent, input.mode);
      return { plans };
    }),

  /** 微调 AI 生图画面描述：一句话修改意见 → LLM 输出修订后的完整描述（仅回填前端，不落库） */
  refineImagePrompt: publicQuery
    .input(
      z.object({
        prompt: z.string().min(2).max(500),
        instruction: z.string().min(1).max(300),
        mode: z.enum(["illustration", "infographic"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const revised = await refineImagePrompt(input.prompt, input.instruction, input.mode ?? "illustration");
      return { prompt: revised };
    }),

  /** AI 文生图配图：先插入「生成中」占位行立即返回，后台完成生图后改写该行。
   *  这样不受平台 60 秒网关限制——大图生成实测需 40-60 秒。前端轮询 notes.get 自动刷新。 */
  addAiImage: publicQuery
    .input(
      z.object({
        noteId: z.number(),
        prompt: z.string().min(2).max(500),
        mode: z.enum(["illustration", "infographic"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const note = await getNoteOrThrow(input.noteId);
      const placeholder: PhotoSpec = {
        kind: "photo",
        title: "",
        name: "AI 生图",
        width: 0,
        height: 0,
        dataUrl: "",
        source: "ai",
        prompt: input.prompt.trim(),
        aiMode: input.mode ?? "illustration",
        generating: true,
        ...(note.svgTheme ? { theme: note.svgTheme } : {}),
      };
      const existing = await getDb().select().from(noteImages).where(eq(noteImages.noteId, input.noteId));
      const inserted = await getDb().insert(noteImages).values({
        noteId: input.noteId,
        kind: "photo",
        spec: JSON.stringify(placeholder),
        sortOrder: existing.length,
      });
      const imageId = Number(inserted[0].insertId);
      void runAiImageJob(imageId, input.prompt.trim(), input.mode ?? "illustration");
      return { ok: true, imageId };
    }),

  /** 重新生成 AI 文生图配图（修改画面描述后再画一张；卡住/失败的图也可借此重试） */
  regenAiImage: publicQuery
    .input(z.object({ imageId: z.number(), prompt: z.string().max(500).optional() }))
    .mutation(async ({ input }) => {
      const rows = await getDb().select().from(noteImages).where(eq(noteImages.id, input.imageId)).limit(1);
      const img = rows[0];
      if (!img) throw new Error("图片不存在");
      const spec = JSON.parse(img.spec) as PhotoSpec;
      if (img.kind !== "photo" || spec.source !== "ai") {
        throw new Error("这张配图不是 AI 生图，无法重新生成");
      }
      // 未填新描述时，默认沿用原来的画面描述重新生成
      const prompt = input.prompt?.trim() || img.lastPrompt || spec.prompt || "";
      if (prompt.length < 2) throw new Error("没有找到可复用的画面描述，请填写描述后重新生成");
      const noteRows = await getDb().select().from(notes).where(eq(notes.id, img.noteId)).limit(1);
      const next: PhotoSpec = {
        ...spec,
        prompt,
        generating: true,
        error: undefined,
        theme: noteRows[0]?.svgTheme ?? spec.theme,
      };
      await getDb()
        .update(noteImages)
        .set({ spec: JSON.stringify(next), version: img.version + 1, lastPrompt: prompt })
        .where(eq(noteImages.id, img.id));
      void runAiImageJob(img.id, prompt, spec.aiMode ?? "illustration");
      return { ok: true, version: img.version + 1 };
    }),

  /** 保存编辑（标题/正文/标签）并自动复检 */
  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).max(60),
        body: z.string().min(1),
        tags: z.array(z.string()).max(15),
      }),
    )
    .mutation(async ({ input }) => {
      const qc = runQc({ title: input.title, body: input.body, tags: input.tags });
      await getDb()
        .update(notes)
        .set({
          title: input.title,
          body: input.body,
          tags: JSON.stringify(input.tags),
          qcReport: JSON.stringify(qc),
        })
        .where(eq(notes.id, input.id));
      return { ok: true, qc };
    }),

  /** 换一批候选标题 */
  refreshTitles: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const note = await getNoteOrThrow(input.id);
      const mat = note.materialId
        ? await getDb().select().from(materials).where(eq(materials.id, note.materialId)).limit(1)
        : [];
      const current = safeJsonParse<string[]>(note.titleCandidates, []);
      const fresh = await regenerateTitles(mat[0]?.title ?? note.title, current);
      const merged = [...fresh, ...current].slice(0, 10);
      await getDb()
        .update(notes)
        .set({ titleCandidates: JSON.stringify(merged) })
        .where(eq(notes.id, input.id));
      return { titles: merged };
    }),

  /** 代码卡合集·提示词微调：LLM 在合并后的完整代码上改，改完重新分页，所有代码页一起更新 */
  editCodeGroup: publicQuery
    .input(z.object({ noteId: z.number(), prompt: z.string().min(1).max(300) }))
    .mutation(async ({ input }) => {
      const group = await mergeImageGroup(input.noteId, "code");
      if (!group) throw new Error("这篇笔记没有代码卡");
      const raw = await chatCompletion(
        [{ role: "user", content: buildImageEditPrompt("code", JSON.stringify(group.merged), input.prompt) }],
        { temperature: 0.5, maxTokens: 16000 },
      );
      const rawObj = extractJson<Record<string, unknown>>(raw);
      if (rawObj.code == null) rawObj.code = (group.merged as { code?: string }).code; // LLM 未改代码时输出 null，本地保留原值
      const newSpec = imageSpecSchema.parse(rawObj);
      if (newSpec.kind !== "code") throw new Error("生成结果不是代码卡，请换个描述重试");
      const pages = await replaceImageGroup(input.noteId, "code", group.groupRows, newSpec as CodeSpecLike, input.prompt);
      return { ok: true, pages };
    }),

  /** 代码卡合集·参数保存：表单编辑合并后的完整 spec，保存时重新分页 */
  updateCodeGroup: publicQuery
    .input(z.object({ noteId: z.number(), spec: imageSpecSchema }))
    .mutation(async ({ input }) => {
      if (input.spec.kind !== "code") throw new Error("合集参数必须是代码卡类型");
      const group = await mergeImageGroup(input.noteId, "code");
      if (!group) throw new Error("这篇笔记没有代码卡");
      const pages = await replaceImageGroup(input.noteId, "code", group.groupRows, input.spec as CodeSpecLike);
      return { ok: true, pages };
    }),

  /** 题目描述图合集·提示词微调：LLM 在合并后的完整题目文字上改，改完重新分页 */
  editProblemGroup: publicQuery
    .input(z.object({ noteId: z.number(), prompt: z.string().min(1).max(300) }))
    .mutation(async ({ input }) => {
      const group = await mergeImageGroup(input.noteId, "problem");
      if (!group) throw new Error("这篇笔记没有题目描述图");
      const raw = await chatCompletion(
        [{ role: "user", content: buildImageEditPrompt("problem", JSON.stringify(group.merged), input.prompt) }],
        { temperature: 0.5, maxTokens: 16000 },
      );
      const rawObj = extractJson<Record<string, unknown>>(raw);
      const origText = (group.merged as { text?: string }).text ?? "";
      if (rawObj.text == null) {
        // LLM 未整体重写：先本地应用 textPatches（少量修改只输出 find/replace 片段，token 极省），无补丁则保留原文
        rawObj.text = rawObj.textPatches != null ? applyTextPatches(origText, rawObj.textPatches) : origText;
      }
      const newSpec = imageSpecSchema.parse(rawObj);
      if (newSpec.kind !== "problem") throw new Error("生成结果不是题目描述图，请换个描述重试");
      const pages = await replaceImageGroup(input.noteId, "problem", group.groupRows, newSpec as ProblemSpecLike, input.prompt);
      return { ok: true, pages };
    }),

  /** 题目描述图合集·参数保存：表单编辑合并后的完整 spec，保存时重新分页 */
  updateProblemGroup: publicQuery
    .input(z.object({ noteId: z.number(), spec: imageSpecSchema }))
    .mutation(async ({ input }) => {
      if (input.spec.kind !== "problem") throw new Error("合集参数必须是题目描述图类型");
      const group = await mergeImageGroup(input.noteId, "problem");
      if (!group) throw new Error("这篇笔记没有题目描述图");
      const pages = await replaceImageGroup(input.noteId, "problem", group.groupRows, input.spec as ProblemSpecLike);
      return { ok: true, pages };
    }),

  /** 调整代码卡/题目描述卡合集的图片张数（内容不变，重新分页） */
  setGroupPageCount: publicQuery
    .input(z.object({ noteId: z.number(), kind: z.enum(["code", "problem"]), pages: z.number().int().min(1).max(6) }))
    .mutation(async ({ input }) => {
      const group = await mergeImageGroup(input.noteId, input.kind);
      if (!group) throw new Error("这篇笔记没有该类型的配图");
      const pages = await replaceImageGroup(input.noteId, input.kind, group.groupRows, group.merged, undefined, input.pages);
      return { ok: true, pages };
    }),

  /** 提示词改图：LLM 把自然语言翻译成新的模板参数 */
  editImageByPrompt: publicQuery
    .input(z.object({ imageId: z.number(), prompt: z.string().min(1).max(300) }))
    .mutation(async ({ input }) => {
      const rows = await getDb().select().from(noteImages).where(eq(noteImages.id, input.imageId)).limit(1);
      const img = rows[0];
      if (!img) throw new Error("图片不存在");
      if (img.kind === "photo") throw new Error("素材插图是原图，不支持提示词改图；如需新图请用「添加配图」生成");

      const raw = await chatCompletion(
        [{ role: "user", content: buildImageEditPrompt(img.kind, img.spec, input.prompt) }],
        { temperature: 0.5, maxTokens: 16000 },
      );
      const rawObj = extractJson<Record<string, unknown>>(raw);
      // 长字段输出 null 时保留原值（代码卡/题目描述卡微调不复述长文）
      const oldSpec = safeJsonParse(img.spec, {} as Record<string, unknown>);
      for (const f of ["code", "text"] as const) {
        if (rawObj[f] == null && oldSpec[f] != null) {
          // 题目文字：有 textPatches 先本地打补丁，否则保留原值
          rawObj[f] = f === "text" && rawObj.textPatches != null ? applyTextPatches(String(oldSpec[f]), rawObj.textPatches) : oldSpec[f];
        }
      }
      const newSpec = imageSpecSchema.parse(rawObj);
      await getDb()
        .update(noteImages)
        .set({
          spec: JSON.stringify(newSpec),
          version: img.version + 1,
          lastPrompt: input.prompt,
        })
        .where(eq(noteImages.id, img.id));
      return { ok: true, spec: newSpec, version: img.version + 1 };
    }),

  /** 直接改模板参数（表单编辑） */
  updateImageSpec: publicQuery
    .input(z.object({ imageId: z.number(), spec: imageSpecSchema }))
    .mutation(async ({ input }) => {
      const rows = await getDb().select().from(noteImages).where(eq(noteImages.id, input.imageId)).limit(1);
      if (!rows[0]) throw new Error("图片不存在");
      await getDb()
        .update(noteImages)
        .set({ spec: JSON.stringify(input.spec), version: rows[0].version + 1 })
        .where(eq(noteImages.id, input.imageId));
      return { ok: true };
    }),

  /** 删除一张配图 */
  removeImage: publicQuery.input(z.object({ imageId: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(noteImages).where(eq(noteImages.id, input.imageId));
    return { ok: true };
  }),

  /** 设置笔记级 AI 画风：本篇之后所有 AI 生图（含重新生成）统一用该风格 */
  setNoteStyle: publicQuery
    .input(z.object({ noteId: z.number(), aiStyle: z.string().max(32) }))
    .mutation(async ({ input }) => {
      await getDb().update(notes).set({ aiStyle: input.aiStyle }).where(eq(notes.id, input.noteId));
      return { ok: true };
    }),

  /** 设置笔记级模板图配色：存为默认（新模板图套用），并把已有模板图一键统一 */
  setNoteTheme: publicQuery
    .input(z.object({ noteId: z.number(), theme: z.string().max(32) }))
    .mutation(async ({ input }) => {
      await getDb().update(notes).set({ svgTheme: input.theme }).where(eq(notes.id, input.noteId));
      const imgs = await getDb().select().from(noteImages).where(eq(noteImages.noteId, input.noteId));
      let updated = 0;
      for (const img of imgs) {
        const spec = safeJsonParse(img.spec, {} as Record<string, unknown>);
        if (img.kind === "photo" && spec.source !== "ai") continue; // 素材原图没有配色参数
        if (spec.theme === input.theme) continue;
        spec.theme = input.theme;
        await getDb().update(noteImages).set({ spec: JSON.stringify(spec) }).where(eq(noteImages.id, img.id));
        updated++;
      }
      return { ok: true, updated };
    }),

  /** 获取（或首次生成）同步令牌：配置到服务器的同步服务环境变量 SYNC_TOKEN */
  getSyncToken: publicQuery.query(async () => {
    let token = await getSetting(SETTING_KEYS.xhsSyncToken);
    if (!token) {
      token = randomBytes(24).toString("hex");
      await setSetting(SETTING_KEYS.xhsSyncToken, token);
    }
    return { token };
  }),

  /** 用户点「同步到草稿箱」第一步：只传标题/正文/标签和图片名单，图片随后逐张上传（避免单次请求超限） */
  requestSync: publicQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).max(255),
        body: z.string().min(1).max(20000),
        tags: z.array(z.string().max(60)).max(30),
        imageNames: z.array(z.string().max(120)).min(1).max(18).optional(),
        // 兼容旧版前端：一次性带全部图片（浏览器缓存未刷新时仍可用）
        images: z
          .array(z.object({ name: z.string().max(120), dataUrl: z.string().startsWith("data:image/") }))
          .min(1)
          .max(18)
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await getNoteOrThrow(input.id);
      const imageNames = input.imageNames ?? (input.images ?? []).map((i) => i.name);
      if (imageNames.length === 0) throw new Error("缺少图片");
      // 负载只存元数据；图片一张一行存 note_sync_images，避免巨型负载反复读写导致超时
      const payload = JSON.stringify({ title: input.title, body: input.body, tags: input.tags, imageNames });
      await getDb().delete(noteSyncImages).where(eq(noteSyncImages.noteId, input.id));
      // 兼容旧版前端一次性带图：直接逐行入库
      if (!input.imageNames && input.images) {
        await getDb()
          .insert(noteSyncImages)
          .values(input.images.map((img, i) => ({ noteId: input.id, idx: i, name: img.name, dataUrl: img.dataUrl })));
      }
      await getDb()
        .update(notes)
        .set({ syncStatus: "pending", syncPayload: payload, syncError: null })
        .where(eq(notes.id, input.id));
      return { ok: true, imageCount: imageNames.length };
    }),

  /** 第二步：逐张上传图片（每张一个请求、一行记录，读写量与图片数量无关） */
  syncUploadImage: publicQuery
    .input(
      z.object({
        id: z.number(),
        index: z.number().int().min(0).max(17),
        name: z.string().max(120),
        dataUrl: z.string().startsWith("data:image/").max(20 * 1024 * 1024),
      }),
    )
    .mutation(async ({ input }) => {
      const row = await getNoteOrThrow(input.id);
      if (row.syncStatus !== "pending" || !row.syncPayload)
        throw new Error("同步任务不存在或已被取走，请重新点「同步到草稿箱」");
      const payload = safeJsonParse(row.syncPayload, {} as { imageNames?: string[] });
      const total = payload.imageNames?.length ?? 0;
      if (input.index >= total) throw new Error("图片序号超出范围，请重新点「同步到草稿箱」");
      await getDb()
        .insert(noteSyncImages)
        .values({ noteId: input.id, idx: input.index, name: input.name, dataUrl: input.dataUrl })
        .onDuplicateKeyUpdate({ set: { name: input.name, dataUrl: input.dataUrl } });
      return { ok: true, total };
    }),

  /** 同步服务拉取任务（带令牌）：取最早一篇图片已传齐的待同步笔记，置为「同步中」避免重复拉取 */
  syncPull: publicQuery
    .input(z.object({ token: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await requireSyncToken(input.token);
      const rows = await getDb()
        .select()
        .from(notes)
        .where(eq(notes.syncStatus, "pending"))
        .orderBy(asc(notes.id))
        .limit(10);
      for (const row of rows) {
        if (!row.syncPayload) continue;
        let payload: { title: string; body: string; tags: string[]; imageNames?: string[] };
        try {
          payload = JSON.parse(row.syncPayload);
        } catch {
          continue;
        }
        const total = payload.imageNames?.length ?? 0;
        if (total === 0) continue;
        const imgs = await getDb()
          .select()
          .from(noteSyncImages)
          .where(eq(noteSyncImages.noteId, row.id))
          .orderBy(asc(noteSyncImages.idx));
        if (imgs.length < total) continue; // 图片还没传完，跳过
        await getDb().update(notes).set({ syncStatus: "syncing" }).where(eq(notes.id, row.id));
        return {
          empty: false as const,
          noteId: row.id,
          title: payload.title,
          body: payload.body,
          tags: payload.tags,
          images: imgs.slice(0, total).map((i) => ({ name: i.name, dataUrl: i.dataUrl })),
        };
      }
      return { empty: true as const };
    }),

  /** 同步服务回写结果：queued=已进入服务器待发布队列 published=已发布 ignored=已忽略 failed=失败 */
  syncReport: publicQuery
    .input(
      z.object({
        token: z.string().min(1),
        noteId: z.number(),
        status: z.enum(["queued", "published", "ignored", "failed"]),
        error: z.string().max(500).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await requireSyncToken(input.token);
      const patch =
        input.status === "failed"
          ? { syncStatus: "failed", syncError: input.error ?? "未知错误" } // 保留负载便于重试
          : {
              syncStatus: input.status,
              syncError: null,
              syncPayload: null, // 已到达服务器，清空图片负载省空间
              ...(input.status !== "ignored" ? { syncedAt: new Date() } : {}),
            };
      await getDb().update(notes).set(patch).where(eq(notes.id, input.noteId));
      if (input.status !== "failed")
        await getDb().delete(noteSyncImages).where(eq(noteSyncImages.noteId, input.noteId)); // 清理分片图片
      return { ok: true };
    }),

  setStatus: publicQuery
    .input(z.object({ id: z.number(), status: z.enum(["draft", "published"]) }))
    .mutation(async ({ input }) => {
      await getDb().update(notes).set({ status: input.status }).where(eq(notes.id, input.id));
      return { ok: true };
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(noteImages).where(eq(noteImages.noteId, input.id));
    await getDb().delete(notes).where(eq(notes.id, input.id));
    return { ok: true };
  }),
});

type QcItemLike = { level: string; item: string; message: string };
type CodeSpecLike = Extract<ImageSpec, { kind: "code" }>;
type ProblemSpecLike = Extract<ImageSpec, { kind: "problem" }>;
