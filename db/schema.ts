import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  mediumtext,
  longtext,
  timestamp,
  bigint,
  int,
  boolean,
  primaryKey,
} from "drizzle-orm/mysql-core";

// ============ 素材库：从飞书链接 / 粘贴文本导入的题解素材 ============
export const materials = mysqlTable("materials", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 512 }).notNull(),
  sourceType: mysqlEnum("source_type", ["link", "paste"]).notNull(),
  sourceUrl: varchar("source_url", { length: 1024 }),
  content: mediumtext("content").notNull(),
  status: mysqlEnum("status", ["ready", "failed"]).notNull().default("ready"),
  errorMsg: varchar("error_msg", { length: 1024 }),
  // LLM 提取的素材骨架（markdown 大纲），支持手动修改/微调
  skeleton: mediumtext("skeleton"),
  // JSON string: OutlineAngle[]，骨架提取时一并产出的创作角度
  angles: text("angles"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ============ 笔记：一篇小红书图文笔记 ============
export const notes = mysqlTable("notes", {
  id: serial("id").primaryKey(),
  materialId: bigint("material_id", { mode: "number", unsigned: true }),
  title: varchar("title", { length: 255 }).notNull().default(""),
  // JSON string: string[]，5 个候选标题
  titleCandidates: text("title_candidates"),
  body: mediumtext("body").notNull().default(""),
  // JSON string: string[]，标签
  tags: text("tags"),
  status: mysqlEnum("status", ["draft", "published"]).notNull().default("draft"),
  // JSON string: 质检报告 [{level, item, message}]
  qcReport: text("qc_report"),
  // 演示模式（未配置 LLM Key 时）生成的笔记
  isDemo: boolean("is_demo").notNull().default(false),
  // 笔记级 AI 生图画风（见 contracts AI_STYLES），本篇笔记所有 AI 图片统一
  aiStyle: varchar("ai_style", { length: 32 }).notNull().default("flat"),
  // 笔记级模板图默认配色；设置后新模板图用它，且可一键统一已有模板图
  svgTheme: varchar("svg_theme", { length: 32 }),
  // 小红书草稿箱同步：none=未同步 pending=待拉取 syncing=同步中 synced=已入草稿 failed=失败
  syncStatus: varchar("sync_status", { length: 16 }).notNull().default("none"),
  syncError: text("sync_error"),
  syncedAt: timestamp("synced_at"),
  // 同步负载 JSON：{title, body, tags, images:[{name, dataUrl}]}，同步成功后清空
  syncPayload: longtext("sync_payload"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ============ 笔记配图：参数化 SVG 模板图，spec 为模板参数 JSON ============
export const noteImages = mysqlTable("note_images", {
  id: serial("id").primaryKey(),
  noteId: bigint("note_id", { mode: "number", unsigned: true }).notNull(),
  kind: mysqlEnum("kind", ["cover", "steps", "code", "problem", "quote", "list", "compare", "diagram", "end", "photo"]).notNull(),
  // JSON string: 模板参数，如封面 {title, tag, theme} / 步骤卡 {title, steps[]} / 代码卡 {title, code, lang}
  spec: mediumtext("spec").notNull(),
  sortOrder: int("sort_order").notNull().default(0),
  version: int("version").notNull().default(1),
  // 最近一次「提示词改图」的用户提示词
  lastPrompt: text("last_prompt"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ============ 素材图片：飞书文档中的图片，base64 存储，供编辑器参考/下载 ============
export const materialImages = mysqlTable("material_images", {
  id: serial("id").primaryKey(),
  materialId: bigint("material_id", { mode: "number", unsigned: true }).notNull(),
  token: varchar("token", { length: 128 }).notNull(),
  name: varchar("name", { length: 512 }).notNull().default(""),
  mime: varchar("mime", { length: 64 }).notNull().default("image/png"),
  width: int("width").notNull().default(0),
  height: int("height").notNull().default(0),
  sortOrder: int("sort_order").notNull().default(0),
  dataBase64: mediumtext("data_base64").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ============ 同步图片：「同步到草稿箱」分片上传的图片，一张一行，避免巨型负载反复读写 ============
export const noteSyncImages = mysqlTable(
  "note_sync_images",
  {
    noteId: bigint("note_id", { mode: "number", unsigned: true }).notNull(),
    idx: int("idx").notNull(),
    name: varchar("name", { length: 120 }).notNull().default(""),
    dataUrl: longtext("data_url").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.noteId, t.idx] })],
);

// ============ 叙事工坊·风格档案（单行表，id=1）：样本 + 风格文档 + 开关 + 风格提示词 ============
// 2026-10-17 起替代 /app/data/narrative_style_store.json（ensureSchema 自动一次性迁移）
export const narrativeStyle = mysqlTable("narrative_style", {
  id: serial("id").primaryKey(),
  // JSON string: [{name?: string, text: string}]，最多 10 篇、单篇 ≤2500 字（TEXT 列不给默认值，兼容 MySQL/TiDB；写入方恒提供）
  samples: mediumtext("samples").notNull(),
  // LLM 分析出的风格文档
  profile: mediumtext("profile"),
  enabled: boolean("enabled").notNull().default(false),
  // 风格分析用的系统提示词（空 = 用默认）
  prompt: mediumtext("prompt"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ============ 叙事工坊·工作区状态（单行表，id=1）：提示词/选题素材/初稿/金句卡 ============
// 2026-10-17 起替代 /app/data/narrative_state.json（ensureSchema 自动一次性迁移）
export const narrativeState = mysqlTable("narrative_state", {
  id: serial("id").primaryKey(),
  // 初稿生成系统提示词（空 = 用默认）
  prompt: mediumtext("prompt"),
  noteType: varchar("note_type", { length: 128 }),
  noteGoal: varchar("note_goal", { length: 128 }),
  topic: varchar("topic", { length: 1024 }),
  material: mediumtext("material"),
  // JSON string: {titles,title,body,tags,quote,raw} 或 null
  draft: mediumtext("draft"),
  // JSON string: {quote,sign,theme} 或 null
  card: mediumtext("card"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ============ 设置：LLM 配置、人设提示词等 ============
export const settings = mysqlTable("settings", {
  id: serial("id").primaryKey(),
  skey: varchar("skey", { length: 64 }).notNull().unique(),
  svalue: text("svalue"),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});
