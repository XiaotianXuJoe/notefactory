import { z } from "zod";
import { asc, desc, eq, sql } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { materialImages, materials } from "@db/schema";
import { fetchFeishuDoc } from "./services/feishu";
import type { FeishuImage } from "./services/feishu";
import { extractOutline, refineSkeleton } from "./services/pipeline";
import type { OutlineAngle } from "./services/prompts";
import { fetchDouyinVideo, fetchWechatArticle } from "./services/wechat";
import { fetchXhsNote } from "./services/xhs";

/** 按链接域名选择抓取器：抖音视频 / 飞书文档 / 微信公众号文章 / 小红书笔记；抖音、小红书分享文本先提取其中的链接 */
async function fetchByLink(url: string): Promise<{
  title: string;
  content: string;
  images: FeishuImage[];
  warnings: string[];
  sourceLabel: string;
  sourceUrl?: string;
}> {
  const shareM = /(https?:\/\/[^\s\uFF0C\u3002"]+)/.exec(url);
  if (shareM && /douyin\.com|iesdouyin\.com|xiaohongshu\.com|xhslink\.com/.test(shareM[1])) url = shareM[1];
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("链接格式不正确，请检查后重试");
  }
  if (host === "channels.weixin.qq.com") {
    throw new Error("视频号链接只能在微信内打开，服务器无法直接抓取。请把视频标题和文案用「粘贴文本」导入");
  }
  if (host === "mp.weixin.qq.com" || host.endsWith(".weixin.qq.com")) {
    const r = await fetchWechatArticle(url);
    return { ...r, sourceLabel: "公众号文章" };
  }
  if (host.endsWith("feishu.cn") || host.endsWith("larksuite.com")) {
    const r = await fetchFeishuDoc(url);
    return { ...r, sourceLabel: "飞书文档" };
  }
  if (host === "douyin.com" || host.endsWith(".douyin.com") || host === "iesdouyin.com" || host.endsWith(".iesdouyin.com")) {
    const r = await fetchDouyinVideo(url);
    return { ...r, sourceLabel: "抖音视频", sourceUrl: url };
  }
  if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com" || host.endsWith(".xhslink.com")) {
    const r = await fetchXhsNote(url);
    return { ...r, sourceLabel: "小红书笔记", sourceUrl: r.sourceUrl };
  }
  throw new Error("暂不支持该链接，目前支持：抖音视频、飞书文档、微信公众号文章、小红书笔记");
}

export const materialsRouter = createRouter({
  list: publicQuery.query(async () => {
    // 列表裁剪：不 SELECT content 全文，只取长度；图片表只取 materialId 做聚合
    const rows = await getDb()
      .select({
        id: materials.id,
        title: materials.title,
        sourceType: materials.sourceType,
        sourceUrl: materials.sourceUrl,
        status: materials.status,
        errorMsg: materials.errorMsg,
        contentLength: sql`CHAR_LENGTH(${materials.content})`,
        createdAt: materials.createdAt,
      })
      .from(materials)
      .orderBy(desc(materials.createdAt));
    const imgCounts = await getDb().select({ materialId: materialImages.materialId }).from(materialImages);
    const countMap = new Map<number, number>();
    for (const img of imgCounts) {
      countMap.set(img.materialId, (countMap.get(img.materialId) ?? 0) + 1);
    }
    // 列表不返回全文
    return rows.map((r) => {
      let sourceLabel = r.sourceType === "paste" ? "粘贴文本" : "链接导入";
      if (r.sourceUrl) {
        try {
          const host = new URL(r.sourceUrl).hostname.toLowerCase();
          if (host === "channels.weixin.qq.com") sourceLabel = "视频号";
          else if (host === "mp.weixin.qq.com" || host.endsWith(".weixin.qq.com")) sourceLabel = "公众号文章";
          else if (host === "douyin.com" || host.endsWith(".douyin.com") || host === "iesdouyin.com" || host.endsWith(".iesdouyin.com")) sourceLabel = "抖音视频";
          else if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.com" || host.endsWith(".xhslink.com")) sourceLabel = "小红书笔记";
          else if (host.endsWith("feishu.cn") || host.endsWith("larksuite.com")) sourceLabel = "飞书文档";
        } catch { /* 忽略无法解析的 URL */ }
      }
      return {
        id: r.id,
        title: r.title,
        sourceType: r.sourceType,
        sourceLabel,
        sourceUrl: r.sourceUrl,
        status: r.status,
        errorMsg: r.errorMsg,
        contentLength: Number(r.contentLength) || 0,
        imageCount: countMap.get(r.id) ?? 0,
        createdAt: r.createdAt,
      };
    });
  }),

  get: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const rows = await getDb().select().from(materials).where(eq(materials.id, input.id)).limit(1);
    if (!rows[0]) throw new Error("素材不存在");
    return rows[0];
  }),

  /** 提取素材骨架 + 创作角度。已有骨架且未要求强制时直接返回缓存，避免重复消耗 LLM */
  extractOutline: publicQuery
    .input(z.object({ id: z.number(), force: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const rows = await getDb().select().from(materials).where(eq(materials.id, input.id)).limit(1);
      const mat = rows[0];
      if (!mat) throw new Error("素材不存在");
      if (mat.skeleton && !input.force) {
        return {
          skeleton: mat.skeleton,
          angles: mat.angles ? (JSON.parse(mat.angles) as OutlineAngle[]) : [],
          cached: true,
        };
      }
      const outline = await extractOutline(mat.title, mat.content);
      await getDb()
        .update(materials)
        .set({ skeleton: outline.skeleton, angles: JSON.stringify(outline.angles) })
        .where(eq(materials.id, mat.id));
      return { ...outline, cached: false };
    }),

  /** 手动保存骨架 / 角度（用户在界面上直接编辑） */
  saveOutline: publicQuery
    .input(
      z.object({
        id: z.number(),
        skeleton: z.string().min(1).max(6000),
        angles: z.array(z.object({ name: z.string().max(20), focus: z.string().max(100), why: z.string().max(50) })).max(6),
      }),
    )
    .mutation(async ({ input }) => {
      await getDb()
        .update(materials)
        .set({ skeleton: input.skeleton, angles: JSON.stringify(input.angles) })
        .where(eq(materials.id, input.id));
      return { ok: true };
    }),

  /** 编辑素材标题 / 正文；正文变化时骨架与角度失效，下次提取时重新生成 */
  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        title: z.string().min(1).max(512).optional(),
        content: z.string().min(10).max(200_000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.title === undefined && input.content === undefined) throw new Error("请至少提供要修改的标题或正文");
      const fields: { title?: string; content?: string; skeleton?: null; angles?: null } = {};
      if (input.title !== undefined) fields.title = input.title.trim();
      if (input.content !== undefined) {
        fields.content = input.content;
        fields.skeleton = null;
        fields.angles = null;
      }
      await getDb().update(materials).set(fields).where(eq(materials.id, input.id));
      return { ok: true };
    }),

  /** LLM 按一句话要求微调骨架（角度保持不变） */
  refineOutline: publicQuery
    .input(z.object({ id: z.number(), instruction: z.string().min(1).max(300) }))
    .mutation(async ({ input }) => {
      const rows = await getDb().select().from(materials).where(eq(materials.id, input.id)).limit(1);
      const mat = rows[0];
      if (!mat?.skeleton) throw new Error("请先提取骨架再微调");
      const skeleton = await refineSkeleton(mat.skeleton, input.instruction.trim());
      await getDb().update(materials).set({ skeleton }).where(eq(materials.id, mat.id));
      return { skeleton };
    }),

  /** 素材的原图（飞书文档里的图片），以 data URL 形式返回 */
  images: publicQuery.input(z.object({ id: z.number() })).query(async ({ input }) => {
    const rows = await getDb()
      .select()
      .from(materialImages)
      .where(eq(materialImages.materialId, input.id))
      .orderBy(asc(materialImages.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      token: r.token,
      name: r.name,
      width: r.width,
      height: r.height,
      dataUrl: `data:${r.mime};base64,${r.dataBase64}`,
    }));
  }),

  importLink: publicQuery
    .input(z.object({ url: z.string().min(5).max(2000) }))
    .mutation(async ({ input }) => {
      const { title, content, images, warnings, sourceLabel, sourceUrl: cleanUrl } = await fetchByLink(input.url.trim());
      // 抓取耗时较长，期间池化连接可能被服务端断开；失败时重试一次
      const doInsert = async () => {
        const inserted = await getDb()
          .insert(materials)
          .values({ title, sourceType: "link" as const, sourceUrl: cleanUrl ?? input.url.trim(), content, status: "ready" as const });
        const materialId = Number(inserted[0].insertId);
        if (images.length) {
          await getDb()
            .insert(materialImages)
            .values(
              images.map((img, i) => ({
                materialId,
                token: img.token,
                name: img.name,
                mime: img.mime,
                width: img.width,
                height: img.height,
                sortOrder: i,
                dataBase64: img.dataBase64,
              })),
            );
        }
        return materialId;
      };
      let materialId: number;
      try {
        materialId = await doInsert();
      } catch (e) {
        try {
          materialId = await doInsert();
        } catch (e2) {
          const cause = (e2 as { cause?: Error }).cause;
          throw new Error(
            `素材入库失败：${cause?.message ?? (e2 as Error).message}（正文 ${content.length} 字已抓取成功，可直接改用粘贴文本导入）`,
          );
        }
      }
      return { id: materialId, title, sourceLabel, contentLength: content.length, imageCount: images.length, warnings };
    }),

  importText: publicQuery
    .input(z.object({ title: z.string().min(1), content: z.string().min(10) }))
    .mutation(async ({ input }) => {
      const doInsert = () =>
        getDb()
          .insert(materials)
          .values({
            title: input.title.trim(),
            sourceType: "paste" as const,
            content: input.content,
            status: "ready" as const,
          });
      try {
        const inserted = await doInsert();
        return { id: Number(inserted[0].insertId) };
      } catch (e) {
        try {
          const inserted = await doInsert();
          return { id: Number(inserted[0].insertId) };
        } catch (e2) {
          const cause = (e2 as { cause?: Error }).cause;
          throw new Error(
            `素材入库失败：${(cause?.message ?? (e2 as Error).message).slice(0, 300)}`,
          );
        }
      }
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    await getDb().delete(materialImages).where(eq(materialImages.materialId, input.id));
    await getDb().delete(materials).where(eq(materials.id, input.id));
    return { ok: true };
  }),
});
