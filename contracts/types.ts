export * from "./errors";

// ============ 配图模板规格（前后端共享） ============

export type CoverSpec = {
  kind: "cover";
  title: string; // 封面大字标题（建议 ≤12 字）
  tag: string; // 角标，如「贪心」「动态规划」
  subtitle: string; // 副标题一句话
  theme: "orange" | "blue" | "dark" | "green";
};

export type StepsSpec = {
  kind: "steps";
  title: string;
  steps: { t: string; d: string }[]; // 2-4 步
  theme: "orange" | "blue" | "dark" | "green";
};

export type CodeSpec = {
  kind: "code";
  title: string;
  lang: string; // python / java / cpp ...
  code: string; // 核心代码片段（过长时系统自动分页成多张卡）
  note: string; // 底部一句提示，如「时间复杂度 O(n)」
  theme: "orange" | "blue" | "dark" | "green";
  lineOffset?: number; // 分页代码卡的起始行号偏移（第 2 张卡从 15 开始编号）
};

export type ProblemSpec = {
  kind: "problem";
  title: string; // 卡片标题，如「题目描述」（分页时自动加（1/3）序号）
  text: string; // 完整题目描述文字（可以很长，系统自动分页成多张卡）
  theme: "orange" | "blue" | "dark" | "green";
  truncated?: boolean; // 超过最大页数被截断时，末页显示「余下见正文」提示
};

export type QuoteSpec = {
  kind: "quote";
  title: string; // 卡片顶部小标题
  quote: string; // 金句正文（建议 ≤40 字）
  sub: string; // 底部补充一句
  theme: "orange" | "blue" | "dark" | "green";
};

export type ListSpec = {
  kind: "list";
  title: string;
  items: string[]; // 3-7 条要点，每条 ≤16 字
  theme: "orange" | "blue" | "dark" | "green";
};

export type CompareSpec = {
  kind: "compare";
  title: string;
  leftLabel: string; // 左栏标签，如「错误思路」
  leftPoints: string[]; // 2-4 条
  rightLabel: string; // 右栏标签，如「正确姿势」
  rightPoints: string[]; // 2-4 条
  theme: "orange" | "blue" | "dark" | "green";
};

export type EndSpec = {
  kind: "end";
  title: string; // 互动提问，如「这道题你能独立写出来吗」
  lines: string[]; // 2-3 行引导语
  cta?: string; // 底部按钮文字，默认「关注 @闭着眼睛学数理化」，宽度自适应
  theme: "orange" | "blue" | "dark" | "green";
};

/** 流程图：LLM 生成 Mermaid 代码，前端精确渲染（内容 100% 准确） */
export type DiagramSpec = {
  kind: "diagram";
  title: string; // 卡片标题，≤12 字
  mermaid: string; // Mermaid 流程图代码（flowchart TD）
  theme: "orange" | "blue" | "dark" | "green";
};

export type ImageSpec = CoverSpec | StepsSpec | CodeSpec | ProblemSpec | QuoteSpec | ListSpec | CompareSpec | EndSpec | DiagramSpec;

export type ImageKind = ImageSpec["kind"];

/** 素材原图 / AI 文生图直接作为配图，不经过模板渲染 */
export type PhotoSpec = {
  kind: "photo";
  title: string; // 展示名（默认为图片文件名）
  name: string; // 原始文件名
  width: number;
  height: number;
  dataUrl: string; // data:image/...;base64,...
  source?: "material" | "ai"; // material=素材原图（默认）；ai=文生图 API 生成
  prompt?: string; // source=ai 时的画面描述（用于再次生成）
  aiMode?: "illustration" | "infographic"; // AI 生图模式：氛围插画 / 内容信息图
  generating?: boolean; // source=ai 专用：后台生成中（占位行，完成后由服务端改写）
  error?: string; // 生成失败原因（可修改描述后重新生成）
  theme?: string; // AI 生图背景底色（跟随笔记统一配色，画面未填满时露出）
};

/** 笔记配图 = AI 生成模板图 | 素材原图 */
export type NoteImageSpec = ImageSpec | PhotoSpec;
export type NoteImageKind = NoteImageSpec["kind"];

/** 图片类型元信息：用于生成/添加配图时的选择界面 */
export const IMAGE_KIND_META: { kind: ImageKind; label: string; desc: string }[] = [
  { kind: "cover", label: "封面图", desc: "大字标题 + 角标，笔记门面" },
  { kind: "steps", label: "思路步骤图", desc: "2-4 步解题流程拆解" },
  { kind: "code", label: "代码卡", desc: "带行号的深色代码片段" },
  { kind: "problem", label: "题目描述图", desc: "大段题目原文/描述，超长自动分页多图" },
  { kind: "quote", label: "金句卡", desc: "一句戳中痛点/点醒读者的话" },
  { kind: "list", label: "要点清单卡", desc: "3-7 条干货要点罗列" },
  { kind: "compare", label: "对比卡", desc: "左右两栏对比，如错误 vs 正确思路" },
  { kind: "diagram", label: "流程图", desc: "Mermaid 精确渲染，结构零出错" },
  { kind: "end", label: "结尾互动卡", desc: "提问 + 关注引导收尾" },
];

// ============ 质检报告 ============

export type QcItem = {
  level: "pass" | "warn" | "fail";
  item: string;
  message: string;
};

// ============ 设置项 key ============

export const SETTING_KEYS = {
  llmBaseUrl: "llm_base_url",
  llmApiKey: "llm_api_key",
  llmModel: "llm_model",
  personaPrompt: "persona_prompt",
  styleSamples: "style_samples",
  imgBaseUrl: "img_base_url",
  imgApiKey: "img_api_key",
  imgModel: "img_model",
  xhsSyncToken: "xhs_sync_token",
  llmDisableThinking: "llm_disable_thinking", // "1"=关闭思考（k2.6 提速）
  llmTemperature: "llm_temperature", // 空串=自动（关思考的 k2.x→0.6，思考模型→1）
} as const;

export const DEFAULT_LLM_BASE_URL = "https://api.moonshot.cn/v1";
export const DEFAULT_LLM_MODEL = "kimi-k3";

// 文生图默认走火山引擎方舟（即梦 Seedream），OpenAI 兼容 /images/generations 接口
export const DEFAULT_IMG_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_IMG_MODEL = "doubao-seedream-4-0-250828";

// ============ AI 生图画风：笔记级统一风格 ============
// prompt 会追加到每次生图请求末尾，保证同一篇笔记的 AI 图片画风一致
export const AI_STYLES = [
  { id: "flat", label: "扁平插画", desc: "清新明亮，简洁干净", prompt: "清新扁平插画风格，矢量质感，配色明亮，画面简洁干净" },
  { id: "clay3d", label: "3D 质感", desc: "黏土渲染，圆润可爱", prompt: "3D 黏土渲染风格，Blender 质感，造型圆润可爱，柔和光影" },
  { id: "watercolor", label: "水彩手绘", desc: "柔和文艺，笔触温润", prompt: "水彩手绘风格，笔触温润柔和，色调清新文艺" },
  { id: "pixel", label: "像素风", desc: "复古 8-bit 游戏感", prompt: "复古像素画风格，8-bit 游戏质感，色块分明，色彩明快" },
  { id: "lineart", label: "极简线条", desc: "线稿留白，高级简约", prompt: "极简线条插画风格，单色线稿配少量点缀色，大量留白，高级简约" },
  { id: "realistic", label: "摄影写实", desc: "真实光影，照片质感", prompt: "写实摄影风格，真实光影与景深，高清照片质感" },
] as const;
export type AiStyleId = (typeof AI_STYLES)[number]["id"];
export const DEFAULT_AI_STYLE: AiStyleId = "flat";
export function getAiStylePrompt(id: string | null | undefined): string {
  return AI_STYLES.find((s) => s.id === id)?.prompt ?? AI_STYLES[0].prompt;
}
