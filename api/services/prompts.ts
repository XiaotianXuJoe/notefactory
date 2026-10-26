/**
 * 提示词体系：人设、笔记生成、图片生成/修改、正文改写。
 * 人设提示词会被用户在「设置」页覆盖（settings.persona_prompt）。
 */
import { getSetting } from "./settings";
import { SETTING_KEYS, type ImageKind } from "@contracts/types";

export const DEFAULT_PERSONA = `你是小红书头部编程博主「闭着眼睛学数理化」，粉丝称呼你许老师。
你的账号定位：面向基础薄弱的校招/社招转码人群，讲华为OD机考真题和 LeetCode 算法题，口号是"闭着眼睛也能学会"。

你的语言风格（必须严格遵守）：
1. 极度口语化，像朋友聊天，多用"举个栗子""开了天眼你就懂了""说白了""别慌"
2. 讲解遵循"先直觉、后套路、再代码"：先用生活化类比建立直觉，再总结可复用的解题模板，最后给代码
3. 代码必须逐行写中文注释，注释比代码长是常态
4. 不堆术语，非用不可的术语一定当场用大白话解释
5. 适当鼓励读者："这题看着唬人，其实就是纸老虎"
6. emoji 用得克制但精准，每段最多 1 个

小红书格式要求：
1. 标题 ≤20 字，必须有数字或时间承诺（如"20天拿下华为OD"），可用「」【】，emoji 不超过 2 个
2. 正文五段式结构：痛点钩子 → 题目速览 → 思路直觉 → 时空复杂度 → 互动引导；正文不含代码块（代码由代码卡呈现，最多一句话概括思路），全文 600~800 字
3. 段落短，多换行，适合手机阅读
4. 互动引导段固定收尾：提问引导评论 + 关注「闭着眼睛学数理化」追更
5. 引流话术克制：只在结尾轻提"完整题解和动画讲解已整理"，不出现微信号、不出现"加微信"等硬引流词`;

export async function getPersonaPrompt(): Promise<string> {
  const custom = await getSetting(SETTING_KEYS.personaPrompt);
  return custom && custom.trim().length > 20 ? custom : DEFAULT_PERSONA;
}

export async function getStyleSamples(): Promise<string> {
  return (await getSetting(SETTING_KEYS.styleSamples)) ?? "";
}

/** 笔记类型：决定正文侧重 */
export const NOTE_TYPES: Record<string, string> = {
  solution: "题解笔记（默认）：痛点钩子 → 题目速览 → 思路直觉 → 代码思路一句话 → 复杂度 → 互动引导",
  summary: "知识点总结：把一个知识点拆成体系化的要点清单，少代码多结论，适合收藏向",
  experience: "面试经验谈：第一人称叙述，重故事和心得，代码为辅",
  roadmap: "学习路线：按阶段拆分学习路径，重规划、资源推荐和避坑",
};

export type GenerateOptions = {
  noteType?: string;
  instruction?: string;
  imageKinds?: ImageKind[];
  /** 素材骨架（创作者确认/修改过的大纲），让正文围绕骨架组织 */
  skeleton?: string;
  /** 创作角度（本篇侧重点），如「易错点避坑：重点讲三个易错边界」 */
  angle?: string;
};

/** 创作角度（骨架提取时一并产出） */
export type OutlineAngle = { name: string; focus: string; why: string };

/** 各图片类型的 JSON schema 说明（生成/编辑共用） */
export const IMAGE_SPEC_SCHEMAS: Record<ImageKind, string> = {
  cover: `{"kind":"cover","title":"封面大字标题，≤10字，要有冲击力","tag":"算法分类角标，如「贪心」","subtitle":"一句话副标题，≤16字","theme":"orange"}`,
  steps: `{"kind":"steps","title":"思路图解标题","steps":[{"t":"步骤名≤8字","d":"一句话说明≤24字"}],"theme":"blue"}，步骤数量控制在3~7个`,
  code: `{"kind":"code","title":"代码卡标题","lang":"python","code":"完整核心代码（可多行，系统会自动分页成多张代码卡），必须保留缩进和逐行中文注释","note":"复杂度一行，如 时间 O(n) · 空间 O(1)","theme":"dark"}`,
  problem: `{"kind":"problem","title":"卡片标题≤10字，如「题目描述」","text":"完整的题目描述原文，保留全部关键信息：题面、数据范围、输入输出说明、示例。可以很长（几百字都没问题），系统会自动分页成多张卡，不要精简省略。小标题（如输入描述、输出描述、示例）用 **文字** 包裹可加粗显示","theme":"blue"}`,
  quote: `{"kind":"quote","title":"卡片小标题≤8字","quote":"金句正文，≤40字，要戳中痛点或点醒读者","sub":"底部补充一句≤16字","theme":"orange"}`,
  list: `{"kind":"list","title":"清单标题≤12字","items":["要点≤16字，3到7条"],"theme":"green"}`,
  compare: `{"kind":"compare","title":"对比标题≤12字","leftLabel":"左栏标签≤6字，如「错误思路」","leftPoints":["2到4条，每条≤14字"],"rightLabel":"右栏标签≤6字，如「正确姿势」","rightPoints":["2到4条，每条≤14字"],"theme":"blue"}`,
  diagram: `{"kind":"diagram","title":"流程图标题≤12字","mermaid":"flowchart TD 开头的 Mermaid 代码，3-6个节点，节点文字≤10字且全部用双引号包裹（如 A[\\"读题建模\\"] --> B[\\"套模板\\"]），禁止括号/冒号等未加引号的特殊字符，不要 subgraph","theme":"blue"}`,
  end: `{"kind":"end","title":"互动提问，如「这道题你能独立写出来吗」","lines":["2到3行引导语，每行≤20字"],"cta":"底部按钮文字≤14字，如 关注 @闭着眼睛学数理化","theme":"orange"}`,
};

/** 生成整篇笔记的提示词（只产出标题/正文/标签；配图参数由 buildMaterialImagePrompt 并行生成，
 *  否则单次输出过大容易触发平台 60 秒网关超时） */
export function buildNotePrompt(materialTitle: string, materialContent: string, samples: string, options?: GenerateOptions): string {
  const truncated = materialContent.slice(0, 12000);
  const sampleBlock = samples.trim()
    ? `\n\n以下是我账号历史爆款笔记范文，请严格对齐它们的语气和结构：\n---\n${samples.slice(0, 6000)}\n---\n`
    : "";

  const noteTypeLine = options?.noteType && NOTE_TYPES[options.noteType]
    ? `\n笔记类型：${NOTE_TYPES[options.noteType]}\n`
    : `\n笔记类型：${NOTE_TYPES.solution}\n`;
  const skeletonLine = options?.skeleton?.trim()
    ? `\n素材骨架（创作者已确认，正文必须围绕这个骨架组织，不要偏离）：\n---\n${options.skeleton.trim().slice(0, 3000)}\n---\n`
    : "";
  const angleLine = options?.angle?.trim()
    ? `\n本篇创作角度/侧重点（全篇内容都要服务于这个角度，突出它、弱化其他）：\n${options.angle.trim().slice(0, 300)}\n`
    : "";
  const instructionLine = options?.instruction?.trim()
    ? `\n用户对这篇笔记的额外要求（优先级最高，必须满足）：\n${options.instruction.trim().slice(0, 500)}\n`
    : "";

  return `${sampleBlock}
请根据下面这份素材，写一篇小红书图文笔记。
${noteTypeLine}${angleLine}${skeletonLine}${instructionLine}
素材标题：${materialTitle}
素材内容：
---
${truncated}
---

严格按以下 JSON 格式输出（不要输出任何其他内容，不要输出分析或推理过程，直接给出最终 JSON）：
{
  "titles": ["5个候选标题，每个≤20字，含数字或时间承诺"],
  "body": "正文，总长度 600~800 字（硬性上限 850 字，不含标签；数清楚再交稿，写超了就是废稿，宁少勿多），用 \\n 分段。绝对不要包含任何代码块或代码片段（完整代码会单独渲染成代码卡片，正文里最多用一句话概括代码思路）；必须从头完整写到尾，绝不能中途停止或省略结尾，最后一句话固定是互动钩子（提问引导评论 + 引导关注追更）",
  "tags": ["8到10个标签，不含#号，前4个固定为：华为OD、秋招、算法、程序员，其余按内容分类"]
}

注意：素材里的 ![图片N](attachment://N) 是原文插图占位符，仅供你理解上下文，正文中不要出现这些占位符。`;
}

/** 从素材直接生成一张指定类型配图的参数（与正文生成并行调用，必须在 60 秒内返回） */
export function buildMaterialImagePrompt(
  kind: ImageKind,
  materialTitle: string,
  materialContent: string,
  angle?: string,
): string {
  const angleLine = angle?.trim()
    ? `\n本篇笔记的创作角度（配图内容要服务这个侧重点）：${angle.trim().slice(0, 300)}\n`
    : "";
  return `你负责为小红书算法笔记生成一张配图的模板参数。
${angleLine}
素材标题：${materialTitle}
素材内容（节选）：
---
${materialContent.slice(0, 3000)}
---

请生成「${kind}」类型的配图参数，内容必须与素材强相关。素材里的 ![图片N](attachment://N) 是原文插图占位符，参数中不要出现。
输出 JSON 的 schema 必须严格为：
${IMAGE_SPEC_SCHEMAS[kind]}

只输出 JSON，不要输出其他内容，不要输出分析或推理过程，直接给出最终 JSON。`;
}

/** 提示词修改图片：把自然语言修改请求翻译成新的模板参数 */
export function buildImageEditPrompt(kind: string, currentSpecJson: string, userPrompt: string): string {
  // 代码卡/题目描述卡的内容字段很长，让 LLM（尤其思考模型）复述极易超 max_tokens 被截断。
  // 约定：用户没有要求改动这些长字段时输出 null，由服务器本地保留原值。
  const longFieldRule =
    kind === "code"
      ? `
特别约定："code" 字段很长——如果用户的修改不涉及代码内容本身（如只改标题/配色/复杂度说明），code 输出 null，千万不要复述原代码；只有当用户明确要求修改代码内容时才输出完整新代码。`
      : kind === "problem"
        ? `
特别约定："text" 是素材中的题目原文，很长——
1. 如果用户的修改不涉及题目文字本身（如只改标题/配色/分页），text 输出 null，千万不要复述原文；
2. 如果用户要求对题目文字做少量修改（改几个字/几句话/某个示例/某个数据），text 同样输出 null，改为额外输出 "textPatches" 数组：[{"find":"原文中要被替换的片段（必须从当前 text 里逐字复制，越短越好，能唯一定位即可）","replace":"替换后的文字"}]，可有多条；
3. 只有当用户明确要求整体重写题目时，才输出完整的新 text（这种情况极少）。`
        : "";
  return `你负责修改一张小红书笔记配图的模板参数。

图片类型：${kind}
当前参数 JSON：
${currentSpecJson}

用户的修改要求：${userPrompt}

请输出修改后的完整参数 JSON，schema 必须严格为：
${IMAGE_SPEC_SCHEMAS[kind as ImageKind] ?? IMAGE_SPEC_SCHEMAS.cover}
${longFieldRule}
只输出 JSON，不要输出其他内容，不要输出分析或推理过程，直接给出最终 JSON。如果用户要求改配色，theme 只能是 orange/blue/dark/green 之一。`;
}

/** 为已有笔记单独生成一张指定类型的配图 */
export function buildImageGenPrompt(kind: ImageKind, noteTitle: string, noteBody: string, userPrompt?: string): string {
  return `你负责为小红书算法笔记生成一张配图的模板参数。

笔记标题：${noteTitle}
笔记正文（节选）：
---
${noteBody.slice(0, 1500)}
---

请生成「${kind}」类型的配图参数，内容必须与笔记正文强相关。
${userPrompt?.trim() ? `用户额外要求：${userPrompt.trim().slice(0, 300)}\n` : ""}
输出 JSON 的 schema 必须严格为：
${IMAGE_SPEC_SCHEMAS[kind]}

只输出 JSON，不要输出其他内容，不要输出分析或推理过程，直接给出最终 JSON。`;
}

/** 按用户指令改写笔记正文 */
export function buildRewritePrompt(noteTitle: string, body: string, instruction: string): string {
  return `你负责按用户要求改写小红书笔记正文。

笔记标题：${noteTitle}
当前正文：
---
${body.slice(0, 8000)}
---

用户的改写要求（优先级最高）：${instruction.slice(0, 500)}

要求：
1. 只输出改写后的正文全文，不要输出任何解释
2. 正文中不要出现代码块，代码由代码卡呈现；保持整体分段风格
3. 总长度严格控制在 850 字以内（超出会被小红书截断）
4. 除非用户要求，不要改动标签和标题`;
}

/** AI 生图的画面方案：LLM 读笔记后产出 3 个候选方案（路线 A）
 *  mode=illustration：氛围插画（无文字，画面与笔记内容强相关）
 *  mode=infographic：内容信息图（图中直接渲染笔记要点文字） */
/** 素材骨架提取 + 创作角度推荐 */
export function buildSkeletonPrompt(materialTitle: string, materialContent: string): string {
  return `你是小红书内容策划。请通读下面这份素材，产出两部分内容。

素材标题：${materialTitle}
素材内容：
----
${materialContent.slice(0, 8000)}
----

【第一部分：素材骨架】
用 markdown 大纲提炼素材的完整结构，要求：
- 用 "## 章节名" 分节，节下用 "- " 列要点
- 保留关键信息：题目/考点、核心思路、关键步骤、代码要点、复杂度、易错点（素材里没有的不要编造）
- 总长度 200-400 字，是"骨架"不是"缩写正文"，每条要点尽量短

【第二部分：创作角度】
基于这份素材，给出 4 个侧重点不同的小红书笔记选题角度，角度之间要有明显差异。可参考的方向（按素材内容灵活选用或自创）：新手向思路讲解、一题多解对比、易错点避坑、复杂度优化深挖、模板套路总结、面试实战话术、同类题串联。
每个角度包含：
- name：角度名称 ≤8字
- focus：这篇笔记重点讲什么、弱化什么，≤40字
- why：为什么这个角度能吸引读者，≤24字

严格按以下 JSON 格式输出（不要输出任何其他内容，不要输出分析或推理过程，直接给出最终 JSON）：
{
  "skeleton": "markdown 骨架全文",
  "angles": [{"name": "...", "focus": "...", "why": "..."}]
}`;
}

/** 骨架微调：按用户一句话要求改骨架，输出完整新骨架 */
export function buildSkeletonRefinePrompt(skeleton: string, instruction: string): string {
  return `这是一份小红书笔记的素材骨架（markdown 大纲）：
---
${skeleton.slice(0, 3000)}
---

请按以下要求微调这份骨架：${instruction.slice(0, 300)}

要求：保持 markdown 大纲格式（## 章节 + - 要点），总长度仍控制在 200-400 字。直接输出修改后的完整骨架，不要输出任何解释或其他内容。`;
}

export function buildImagePlanPrompt(noteTitle: string, noteBody: string, mode: "illustration" | "infographic"): string {
  const modeReq =
    mode === "infographic"
      ? `画面要求（信息图模式）：
1. 图中必须直接渲染从素材提炼的文字：1 个标题（≤12字）+ 3-5 条要点（每条 ≤10字）
2. prompt 里要把这些文字原样写清楚，并注明"图中文字必须严格按上述原文渲染，一个字都不能改"
3. 版式：小红书知识卡片风格，浅色背景，分区排版，配少量装饰小图标`
      : `画面要求（氛围插画模式）：
1. 用一个具体场景/比喻把这篇素材的核心内容可视化，读者看一眼图就能联想到笔记主题
2. 画面要落到具体事物上（物品、人物动作、场景），不要抽象概念堆砌
3. 画面中不出现任何文字、字母、数字`;

  return `你要为下面这篇内容设计 AI 生图的画面方案。这是小红书笔记的原始素材（笔记由它改写而来，素材信息更完整，请基于素材设计，方案将用于小红书配图）。

素材标题：${noteTitle}
素材原文（节选）：
---
${noteBody.slice(0, 2500)}
---

${modeReq}

输出 3 个不同思路的方案，严格按以下 JSON 格式输出（不要输出任何其他内容，不要输出分析或推理过程，直接给出最终 JSON）：
{
  "plans": [
    {"name": "方案名≤6字", "desc": "一句话说明这个画面为什么贴合素材≤24字", "prompt": "完整的画面描述 80-150字，包含主体、动作、场景、配色、风格"}
  ]
}`;
}

/** 定位素材中「题目描述」原文：只输出首尾锚点，本地切片取全文，
 *  避免思考模型复述几百字原文导致 max_tokens 被推理+复述吃光 */
export function buildProblemLocatePrompt(materialContent: string): string {
  return `请从下面素材中定位「题目描述」部分（题面、数据范围、输入输出说明、示例——即原题的完整描述，不要思路讲解和代码）。

素材内容：
---
${materialContent.slice(0, 8000)}
---

严格输出 JSON（不要输出任何其他内容，不要输出分析过程）：
{"start":"题目描述部分原文的前15个字（必须逐字照抄原文，含标点）","end":"题目描述部分原文的最后15个字（必须逐字照抄原文，含标点）"}`;
}

/** 代码卡的标题和复杂度一行（本地已提取代码本体，LLM 只补小字段） */
export function buildCodeMetaPrompt(noteTitle: string, code: string, userPrompt?: string): string {
  return `这是一段「${noteTitle}」的核心代码（已确定为笔记配图）：
---
${code.slice(0, 1500)}
---
${userPrompt?.trim() ? `用户额外要求：${userPrompt.trim().slice(0, 200)}
` : ""}
严格输出 JSON（不要输出任何其他内容，不要输出分析过程）：
{"title":"代码卡标题≤10字","note":"复杂度一行，如 时间 O(n) · 空间 O(1)，根据代码推断"}`;
}

/** 标题重写 */
export function buildTitlePrompt(materialTitle: string, currentTitles: string[]): string {
  return `为算法题解笔记《${materialTitle}》重新生成 5 个小红书标题。
要求：每个 ≤20 字，含数字或时间承诺，口语化有冲击力，emoji 不超过 2 个。
避免与这些重复：${currentTitles.join("、")}
只输出 JSON：{"titles": ["...", "...", "...", "...", "..."]}`;
}
