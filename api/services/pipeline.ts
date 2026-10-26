/**
 * 内容生成流水线：素材 → 笔记（标题×5 / 正文 / 标签 / 配图参数）→ 质检
 * 未配置 LLM Key 时走「演示模式」：基于素材启发式生成，方便先跑通流程。
 */
import { chatCompletion, extractJson, LlmNotConfiguredError } from "./llm";
import {
  buildNotePrompt,
  buildRewritePrompt,
  buildImageGenPrompt,
  buildImagePlanPrompt,
  buildMaterialImagePrompt,
  buildSkeletonPrompt,
  buildSkeletonRefinePrompt,
  buildTitlePrompt,
  getPersonaPrompt,
  getStyleSamples,
  type GenerateOptions,
  type OutlineAngle, buildProblemLocatePrompt, buildCodeMetaPrompt } from "./prompts";
import type { QcItem, ImageSpec, ImageKind, CodeSpec, ProblemSpec } from "@contracts/types";

export type GeneratedImage = { kind: ImageKind; spec: ImageSpec };

/** 配图参数生成专用精简人设：结构化小任务不需要完整博主 persona，
 *  缩短输入可减少思考模型的推理量，避免 max_tokens 被推理吃光 */
const IMAGE_SPEC_SYSTEM =
  "你是小红书笔记配图的参数生成助手。严格按用户给出的 JSON schema 输出，不要输出任何分析、推理或解释过程，直接输出最终 JSON。";

/** 从素材/正文中定位「题目描述」原文：LLM 只输出首尾 15 字锚点，本地切片取全文。
 *  代码卡/题目描述卡的内容本体都很长，让思考模型逐字复述极易把 max_tokens 烧光（截断），
 *  所以长文本一律本地提取，LLM 只做小输出任务。 */
async function locateProblemText(sourceText: string): Promise<string | null> {
  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: IMAGE_SPEC_SYSTEM },
        { role: "user", content: buildProblemLocatePrompt(sourceText) },
      ],
      { temperature: 0.3, maxTokens: 800, timeoutMs: 120_000 },
    );
    const out = extractJson<{ start?: string; end?: string }>(raw);
    const start = (out.start ?? "").trim();
    const end = (out.end ?? "").trim();
    if (start.length < 4 || end.length < 4) return null;
    const i = sourceText.indexOf(start);
    if (i < 0) return null;
    const j = sourceText.indexOf(end, i + start.length);
    if (j < 0) return null;
    const text = sourceText.slice(i, j + end.length).trim();
    return text.length >= 50 ? autoBoldProblemHeaders(text) : null;
  } catch {
    return null;
  }
}

/** 纯本地提取题目描述原文（零 LLM 调用，零 token）：
 *  素材一般是「题目 + 思路/解析/代码」结构，按常见小节标题切出题面部分。
 *  用户要求：题目描述卡直接用素材原文，不做改写。 */
function extractProblemTextLocal(sourceText: string): string | null {
  if (!sourceText || sourceText.trim().length < 50) return null;
  const src = sourceText.replace(/!\[图片\d+\]\(attachment:\d+\)/g, "").trim();
  // 起点：题面类小节标题（找不到则从全文开头起）
  const startM = /(?:^|\n)\s*(?:#+\s*)?(?:题目描述|问题描述|题目要求|题目|问题|描述|Problem\s*Description|Problem|Description)\s*[：:]?\s*(?:\n|$)/i.exec(src);
  const startIdx = startM ? startM.index + (startM[0].startsWith("\n") ? 1 : 0) : 0;
  // 终点：解析/答案/代码类小节标题出现处（题面到此为止）。
  // 注意「解析：/分析：」这类单行也会出现在示例的说明里（如「说明：… 分析：…」），不能当终点——
  // 规则：带 # 的 markdown 标题一律算终点；不带 # 时只认多字强标题（解题思路/代码实现等），
  // 且优先在最后一个「示例/样例」之后找终点，避免切进示例说明内部。
  const endRe = /\n\s*(?:(?:#+\s*(?:解题思路|思路分析|思路|解析|题解|解答|答案|代码实现|参考代码|参考答案|代码|分析|Solution|Answer|Approach))|(?:解题思路|思路分析|题解|解答|代码实现|参考代码|参考答案|Solution))\s*[：:]?\s*(?:\n|$)/i;
  const rest = src.slice(startIdx);
  // 最后一个「示例N/样例N」出现位置：示例说明里可能含「分析：」等干扰行，终点应在所有示例之后
  let exLast = -1;
  const exRe = /示例\s*[一二三四五六七八九十\d]|样例\s*[一二三四五六七八九十\d]/g;
  let exM: RegExpExecArray | null;
  while ((exM = exRe.exec(rest))) exLast = exM.index;
  let endIdx = -1;
  if (exLast >= 0) {
    const m2 = endRe.exec(rest.slice(exLast));
    if (m2) endIdx = exLast + m2.index;
  }
  if (endIdx < 0) {
    const m1 = endRe.exec(rest);
    if (m1) endIdx = m1.index;
  }
  let text = (endIdx > 0 ? rest.slice(0, endIdx) : rest).trim();
  // 清理 markdown 残留：卡片渲染的是纯文本，## 标题井号和 ``` 代码围栏直接显示会很丑
  text = text
    .replace(/^[ \t]*```[^\n]*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // 去掉起始处的 markdown 标题行本身（如「## 题目描述」）
  text = text.replace(/^(?:#+\s*)?(?:题目描述|问题描述|题目要求|题目|问题|描述|Description)\s*[：:]?\s*/i, "").trim();
  // 合理性校验：太短说明切错了，交给后续 LLM 锚点定位兜底
  if (text.length < 50) return null;
  // 没有起点标题时，剩下的内容必须确实像题面（含输入/输出/示例/给定等字样）才采用，避免把整篇素材都当题面
  if (!startM && !/(输入|输出|示例|样例|给定|求|计算|判断|数据范围|约束)/.test(text)) return null;
  return autoBoldProblemHeaders(text);
}

/** 自动给题目原文中的常见小标题加 **加粗** 标记（前端渲染为粗体），已加粗的不重复 */
function autoBoldProblemHeaders(text: string): string {
  return text.replace(
    /(^|\n)(\s*)((?:输入|输出)(?:描述|格式|说明)?|示例\s*[一二三四五六七八九十\d]*|样例\s*[一二三四五六七八九十\d]*|数据范围|约束条件?|提示|备注|说明|注意)(?=\s*[：:]|\s*$)/gm,
    (m, p1, p2, p3: string) => (p3.startsWith("*") ? m : `${p1}${p2}**${p3}**`),
  );
}

/** 代码卡元信息（标题/复杂度一行）：小输出调用，失败回退默认值 */
async function genCodeMeta(noteTitle: string, code: string, userPrompt?: string): Promise<{ title: string; note: string }> {
  const dft = { title: (noteTitle.replace(/[【\[].*?[】\]]/g, "").trim().slice(0, 10) || "核心代码"), note: "" };
  try {
    const raw = await chatCompletion(
      [
        { role: "system", content: IMAGE_SPEC_SYSTEM },
        { role: "user", content: buildCodeMetaPrompt(noteTitle, code, userPrompt) },
      ],
      { temperature: 0.5, maxTokens: 500, timeoutMs: 120_000 },
    );
    const out = extractJson<{ title?: string; note?: string }>(raw);
    return {
      title: (out.title ?? "").trim().slice(0, 10) || dft.title,
      note: (out.note ?? "").trim().slice(0, 40),
    };
  } catch {
    return dft;
  }
}

const CODE_CARD_MAX_LINES = 14; // 每张代码卡最多 14 行（过长自动分页）
const CODE_CARD_MAX_CARDS = 6; // 最多 6 张代码卡

/** 把过长的代码卡拆成多张，标题自动带（1/3）序号。
 *  targetPages：指定精确张数（1~MAX，按行数均分，单页行数可超过默认值） */
export function chunkCodeCards(spec: CodeSpec, targetPages?: number): CodeSpec[] {
  const lines = spec.code.split("\n");
  if (targetPages && targetPages >= 1) {
    const n = Math.min(Math.max(1, Math.round(targetPages)), CODE_CARD_MAX_CARDS, lines.length);
    const per = Math.ceil(lines.length / n);
    const chunks: string[] = [];
    for (let i = 0; i < lines.length; i += per) chunks.push(lines.slice(i, i + per).join("\n"));
    return chunks.map((code, i) => ({
      ...spec,
      title: chunks.length > 1 ? `${spec.title}（${i + 1}/${chunks.length}）` : spec.title,
      code,
      lineOffset: i * per,
    }));
  }
  if (lines.length <= CODE_CARD_MAX_LINES) return [spec];
  // 超过张数上限时不再丢弃代码，改走 targetPages 均分路径（全部行压进上限张数，内容完整优先）
  if (lines.length > CODE_CARD_MAX_CARDS * CODE_CARD_MAX_LINES) return chunkCodeCards(spec, CODE_CARD_MAX_CARDS);
  const chunks: string[] = [];
  for (let i = 0; i < lines.length; i += CODE_CARD_MAX_LINES) {
    chunks.push(lines.slice(i, i + CODE_CARD_MAX_LINES).join("\n"));
  }
  return chunks.map((code, i) => ({
    ...spec,
    title: chunks.length > 1 ? `${spec.title}（${i + 1}/${chunks.length}）` : spec.title,
    code,
    lineOffset: i * CODE_CARD_MAX_LINES,
  }));
}

const PROBLEM_CARD_MAX_LINES = 17; // 每张题目描述卡最多可视行（与前端渲染 36→26px 自适应排版对齐并留余量）
const PROBLEM_CARD_UNITS_PER_LINE = 25; // 每行最大显示宽度（单位宽，CJK=1）
const PROBLEM_CARD_MAX_CARDS = 6; // 最多 6 张题目描述卡

/** 显示宽度估算：与前端 imageRender.charUnits 同规则（服务端另存一份避免跨端引用） */
function problemUnits(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (!/[ -~]/.test(ch)) w += 1;
    else if (/[A-Z]/.test(ch)) w += 0.66;
    else if (/[a-z0-9]/.test(ch)) w += 0.56;
    else if (/\s/.test(ch)) w += 0.32;
    else w += 0.4;
  }
  return w;
}

/** 把题目描述按指定张数均分：先把超长段落硬切成块，再按显示行数均衡分成 N 组 */
export function chunkProblemCardsTo(spec: ProblemSpec, targetPages: number): ProblemSpec[] {
  const n = Math.min(Math.max(1, Math.round(targetPages)), PROBLEM_CARD_MAX_CARDS);
  const paras = spec.text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const estLines = (p: string) => {
    const perLine = /^#\s+/.test(p) ? 18 : /^##\s+/.test(p) ? 20 : PROBLEM_CARD_UNITS_PER_LINE;
    return Math.max(1, Math.ceil(problemUnits(p) / perLine));
  };
  // 块化：超长段落按单页容量硬切成若干块
  const hardLimit = PROBLEM_CARD_MAX_LINES * PROBLEM_CARD_UNITS_PER_LINE;
  const blocks: { text: string; lines: number }[] = [];
  for (const p of paras) {
    if (estLines(p) <= PROBLEM_CARD_MAX_LINES) {
      blocks.push({ text: p, lines: estLines(p) });
    } else {
      let rest = p;
      while (rest) {
        let u = 0, k = 0;
        for (const ch of rest) {
          if (u >= hardLimit) break;
          u += problemUnits(ch);
          k += ch.length;
        }
        blocks.push({ text: rest.slice(0, k), lines: PROBLEM_CARD_MAX_LINES });
        rest = rest.slice(k);
      }
    }
  }
  if (n <= 1 || blocks.length <= 1) return [{ ...spec, text: paras.join("\n\n") }];
  // 贪心均衡分组
  const total = blocks.reduce((a, b) => a + b.lines, 0);
  const budget = Math.ceil((total + blocks.length - n) / n);
  const groups: string[][] = [];
  let cur: string[] = [];
  let curLines = 0;
  for (const b of blocks) {
    const gapCost = cur.length ? 1 : 0;
    if (cur.length && curLines + gapCost + b.lines > budget && groups.length < n - 1) {
      groups.push(cur);
      cur = [];
      curLines = 0;
    }
    if (cur.length) curLines += 1;
    cur.push(b.text);
    curLines += b.lines;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => ({
    ...spec,
    title: groups.length > 1 ? `${spec.title}（${i + 1}/${groups.length}）` : spec.title,
    text: g.join("\n\n"),
  }));
}

/** 把过长的题目描述拆成多张卡：优先按段落边界分页，单段超一页时硬切；标题自动带（1/3）序号 */
export function chunkProblemCards(spec: ProblemSpec): ProblemSpec[] {
  const paras = spec.text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const estLines = (p: string) => {
    const perLine = /^#\s+/.test(p) ? 18 : /^##\s+/.test(p) ? 20 : PROBLEM_CARD_UNITS_PER_LINE;
    return Math.max(1, Math.ceil(problemUnits(p) / perLine));
  };
  type Page = { paras: string[]; lines: number };
  const pages: Page[] = [];
  let cur: Page = { paras: [], lines: 0 };
  const flush = () => {
    if (cur.paras.length) pages.push(cur);
    cur = { paras: [], lines: 0 };
  };
  const hardLimit = PROBLEM_CARD_MAX_LINES * PROBLEM_CARD_UNITS_PER_LINE;
  for (const p of paras) {
    const n = estLines(p);
    if (n <= PROBLEM_CARD_MAX_LINES) {
      const cost = n + (cur.paras.length ? 1 : 0); // 段间空行
      if (cur.paras.length && cur.lines + cost > PROBLEM_CARD_MAX_LINES) flush();
      cur.paras.push(p);
      cur.lines += cost;
    } else {
      // 单段超过一页：先结算当前页，再按显示宽度硬切成整页
      flush();
      let rest = p;
      while (rest) {
        let u = 0;
        let k = 0;
        for (const ch of rest) {
          if (u >= hardLimit) break;
          u += problemUnits(ch);
          k += ch.length;
        }
        pages.push({ paras: [rest.slice(0, k)], lines: PROBLEM_CARD_MAX_LINES });
        rest = rest.slice(k);
      }
    }
  }
  flush();
  if (pages.length <= 1) return [spec];
  // 超过张数上限时不再丢弃内容，改为把全文均衡压进上限张数（前端字号自适应兜底，内容完整优先）
  if (pages.length > PROBLEM_CARD_MAX_CARDS) return chunkProblemCardsTo(spec, PROBLEM_CARD_MAX_CARDS);
  return pages.map((pg, i) => ({
    ...spec,
    title: `${spec.title}（${i + 1}/${pages.length}）`,
    text: pg.paras.join("\n\n"),
  }));
}

export type GeneratedNote = {
  titles: string[];
  body: string;
  tags: string[];
  images: GeneratedImage[];
  isDemo: boolean;
  demoNote?: string;
};

const CATEGORY_KEYWORDS = [
  "动态规划", "贪心", "深度优先", "广度优先", "DFS", "BFS", "二分",
  "哈希", "滑动窗口", "双指针", "回溯", "排序", "链表", "二叉树",
  "图论", "字符串", "模拟", "堆", "栈", "单调栈", "前缀和", "位运算",
];

function guessCategory(text: string): string {
  for (const k of CATEGORY_KEYWORDS) {
    if (text.includes(k)) return k.replace("深度优先", "DFS").replace("广度优先", "BFS");
  }
  return "算法";
}

/** 扫描全部围栏代码块，过滤掉 I/O 小块和纯文本块，返回候选列表（语言缺失时按内容嗅探） */
function extractAllCodeBlocks(content: string): { lang: string; code: string }[] {
  const fenceRe = /```(\w*)\n([\s\S]*?)```/g;
  const out: { lang: string; code: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(content))) {
    const code = m[2].trim();
    if (code.length < 20) continue; // 太短的块（示例输入/输出数字）直接跳过
    // 必须像代码：含关键字/函数定义/注释/赋值等特征，纯文本段落不算
    if (!/(def |class |import |#include|public |static |void |int |return|=>|function |const |let |var |:=|#|\/\/)/.test(code)) continue;
    out.push({ lang: m[1] || sniffLang(code), code });
  }
  return out;
}

function extractCodeBlock(content: string): { lang: string; code: string } | null {
  // 素材/正文里通常有多个围栏块：示例的输入输出（``` 343873 ```）、Python 版、Java 版……
  // 只取第一个会误中 I/O 小块，只取正文又会被 LLM 缩写——改为扫描全部围栏块，挑最长的真实代码块
  const blocks = extractAllCodeBlocks(content);
  if (blocks.length) return blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  // 退化：找一段看起来像代码的连续行
  const lines = content.split("\n");
  const codeLines = lines.filter((l) => /^\s*(def |class |for |while |if |return |#|import )/.test(l));
  if (codeLines.length >= 3) return { lang: "python", code: codeLines.slice(0, 16).join("\n") };
  return null;
}

/** 围栏块没标语言时按内容嗅探（素材里 C/Java 代码常不带语言标记） */
function sniffLang(code: string): string {
  // 顺序敏感：Go 的 `import (` 会被误判为 python，必须先判 Go；C++ 的 #include 先于 C 判
  if (/#include/.test(code)) return /std::|cout|vector<|bits\/c\+\+/.test(code) ? "cpp" : "c";
  if (/^\s*package\s+\w+/m.test(code) || /func\s+\w+\(/.test(code)) return "go";
  if (/public\s+(static|class)|System\.out|import java/.test(code)) return "java";
  if (/^\s*(def |from \w+ import |print\()/m.test(code) || /^\s*class \w+[^(\{]*:\s*$/m.test(code)) return "python";
  if (/function |const |=>|console\.log|console\.log/.test(code)) return "javascript";
  if (/^\s*import [\w,{} ]+\s*$/m.test(code)) return "python"; // 单行 import 兜底算 python
  return "python";
}

/** 在正文和素材里分别提取代码：Python 绝对优先——素材里有 Python 块直接取最长的，
 *  否则正文里的 Python 块，再否则退化为两边各自最长的块（正文优先）。 */
function extractBestCode(noteBody: string, materialContent?: string | null): { lang: string; code: string } | null {
  const matBlocks = materialContent ? extractAllCodeBlocks(materialContent) : [];
  const bodyBlocks = extractAllCodeBlocks(noteBody || "");
  const isPy = (b: { lang: string; code: string }) => {
    const l = (b.lang || "").toLowerCase();
    return l === "python" || l === "py" || l === "python3";
  };
  const pyMat = matBlocks.filter(isPy);
  if (pyMat.length) return pyMat.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const pyBody = bodyBlocks.filter(isPy);
  if (pyBody.length) return pyBody.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const fromBody = extractCodeBlock(noteBody || "");
  const fromMaterial = matBlocks.length ? matBlocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)) : null;
  return fromBody ?? fromMaterial;
}

/** 演示模式下的各类型配图兜底参数 */
function demoSpec(kind: ImageKind, cat: string, shortTitle: string, code: { lang: string; code: string } | null): ImageSpec {
  switch (kind) {
    case "cover":
      return { kind, title: `${cat}题一篇讲透`, tag: cat, subtitle: "闭着眼睛也能学会", theme: "orange" };
    case "steps":
      return {
        kind,
        title: `${cat} · 解题三步`,
        steps: [
          { t: "读题建模", d: "把题目翻译成" + cat + "的标准模型" },
          { t: "套模板", d: "按" + cat + "通用套路分步推进" },
          { t: "写代码", d: "逐行对照注释默写一遍" },
        ],
        theme: "blue",
      };
    case "code":
      return {
        kind,
        title: shortTitle || "核心代码",
        lang: code?.lang ?? "python",
        code: code?.code ?? "# 在素材中加入代码块后，这里会自动提取",
        note: "时间 O(n) · 空间 O(n)",
        theme: "dark",
      };
    case "problem":
      return {
        kind,
        title: "题目描述",
        text: `（演示模式：题目原文占位）\n\n「${shortTitle}」的完整题目描述会在这里按段落排版。描述较长时系统会自动分页成多张卡片，页标题自动带序号。\n\n配置 LLM Key 后，AI 会从素材中提取完整题目原文（含数据范围、输入输出说明、示例）填入这里。`,
        theme: "blue",
      };
    case "quote":
      return { kind, title: "一句话点醒", quote: "模板背十遍，不如真正理解一遍", sub: "闭着眼睛也能学会", theme: "orange" };
    case "list":
      return {
        kind,
        title: `${cat}题解题清单`,
        items: ["识别题型特征", "回忆对应模板", "处理边界情况", "默写核心代码", "分析时空复杂度"],
        theme: "green",
      };
    case "compare":
      return {
        kind,
        title: "错误思路 vs 正确姿势",
        leftLabel: "错误思路",
        leftPoints: ["上来就暴力枚举", "不考虑边界情况"],
        rightLabel: "正确姿势",
        rightPoints: ["先找不变量", "套用" + cat + "模板"],
        theme: "blue",
      };
    case "diagram":
      return {
        kind,
        title: `${cat} · 解题流程`,
        mermaid: `flowchart TD\n  A["读题建模"] --> B["套用${cat}模板"] --> C["处理边界情况"] --> D["输出答案"]`,
        theme: "blue",
      };
    case "end":
      return {
        kind,
        title: "这道题你能独立写出来吗",
        lines: ["评论区聊聊你的思路", "关注追更，每天一道闭眼也能学会的题"],
        theme: "orange",
      };
  }
}

/** 演示模式：不依赖 LLM，从素材启发式拼装一篇结构完整的笔记 */
function demoGenerate(materialTitle: string, content: string, imageKinds: ImageKind[]): GeneratedNote {
  const cat = guessCategory(materialTitle + content);
  const code = extractBestCode("", content);
  const shortTitle = materialTitle
    .replace(/[【\[].*?[】\]]/g, "")
    .replace(/华为OD|笔试|真题/g, "")
    .replace(/[\s\-_—]+/g, "")
    .slice(0, 8) || "这道题";
  const hook = content.split("\n").find((l) => l.length > 20 && l.length < 80) ?? "这道题是华为OD机考的高频题";

  const titles = [
    `20天拿下华为OD之【${cat}】${shortTitle}`,
    `闭眼刷题📌${cat}「${shortTitle}」讲透`,
    `华为OD高频：${shortTitle}套路就这`,
    `注释超详细！${cat}题${shortTitle}题解`,
    `秋招冲刺🔥${shortTitle}闭眼也会写`,
  ];

  const body = `💡 ${hook.slice(0, 50)}，很多人第一次见都懵了，其实套路非常固定。

📋 题目速览
${content.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n").slice(0, 150)}

🧠 思路直觉
说白了，这就是一道「${cat}」的模板题。开个天眼：我们只需要抓住题目的核心不变量，剩下的就是套模板。

💻 代码（逐行注释）
${code ? "```" + code.lang + "\n" + code.code + "\n```" : "# （演示模式未在素材中找到代码块）"}

⏱️ 复杂度
时间复杂度：O(n)，空间复杂度：O(n)。具体推导见配图。

👇 这道题你能独立写出来吗？评论区聊聊。关注「闭着眼睛学数理化」，每天一道闭眼也能学会的算法题。完整题解和动画讲解已整理好～`;

  return {
    titles,
    body,
    tags: ["华为OD", "秋招", "算法", "程序员", cat, "LeetCode", "面试", "编程"],
    images: imageKinds.flatMap((kind): GeneratedImage[] => {
      const spec = demoSpec(kind, cat, shortTitle, code);
      if (kind === "code") return chunkCodeCards(spec as CodeSpec).map((s) => ({ kind, spec: s as ImageSpec }));
      return [{ kind, spec }];
    }),
    isDemo: true,
    demoNote: "演示模式：未配置 LLM API Key，内容为模板拼装。到「设置」页配置 Key 后重新生成，即可获得完整 AI 创作内容。",
  };
}

/** 批量路径单张配图 spec：代码卡/题目描述卡长文本走本地提取（LLM 仅小输出），其余类型走 LLM 生成 */
async function genMaterialImageSpec(
  kind: ImageKind,
  materialTitle: string,
  content: string,
  angle?: string,
): Promise<Partial<ImageSpec> | null> {
  if (kind === "code") {
    const cb = extractBestCode("", content);
    if (cb) {
      const meta = await genCodeMeta(materialTitle, cb.code);
      return { kind, title: meta.title, lang: cb.lang, code: cb.code, note: meta.note, theme: "dark" };
    }
  }
  if (kind === "problem") {
    // 优先纯本地提取（直接用素材原文，零 token、绝不改写）；失败才让 LLM 输出锚点辅助定位
    const text = extractProblemTextLocal(content) ?? (await locateProblemText(content));
    if (text) return { kind, title: "题目描述", text, theme: "blue" };
  }
  return chatCompletion(
    [
      { role: "system", content: IMAGE_SPEC_SYSTEM },
      { role: "user", content: buildMaterialImagePrompt(kind, materialTitle, content, angle) },
    ],
    { temperature: 0.7, maxTokens: 12000, timeoutMs: 170_000 },
  )
    .then((raw): Partial<ImageSpec> | null => {
      try {
        return extractJson<Partial<ImageSpec>>(raw);
      } catch {
        return null;
      }
    })
    .catch((): Partial<ImageSpec> | null => null);
}

/** 主入口：从素材生成笔记
 *  平台网关限制单请求 60 秒，因此正文（标题+正文+标签）与每张配图参数并行请求，
 *  任一配图失败自动回退到模板参数，不影响整篇笔记。 */
export async function generateNote(materialTitle: string, content: string, options?: GenerateOptions): Promise<GeneratedNote> {
  const persona = await getPersonaPrompt();
  const samples = await getStyleSamples();
  const imageKinds = options?.imageKinds?.length ? options.imageKinds : (["cover", "steps", "code"] as ImageKind[]);
  const cat = guessCategory(materialTitle + content);
  const code = extractBestCode("", content);
  const shortTitle = materialTitle.replace(/[【\[].*?[】\]]/g, "").replace(/[\s\-_—]+/g, "").slice(0, 8) || "这道题";
  const demo = demoGenerate(materialTitle, content, imageKinds);

  const bodyPromise = chatCompletion(
    [
      { role: "system", content: persona },
      { role: "user", content: buildNotePrompt(materialTitle, content, samples, options) },
    ],
    { temperature: 0.8, maxTokens: 16000, timeoutMs: 170_000 },
  );
  const specsPromise = Promise.all(
    imageKinds.map((kind) => genMaterialImageSpec(kind, materialTitle, content, options?.angle)),
  );

  type LlmOut = { titles?: string[]; body?: string; tags?: string[] };
  let out: LlmOut;
  let llmSpecs: (Partial<ImageSpec> | null)[];
  try {
    const [bodyRaw, specs] = await Promise.all([bodyPromise, specsPromise]);
    llmSpecs = specs;
    try {
      out = extractJson<LlmOut>(bodyRaw);
    } catch {
      // JSON 解析失败时，退化为纯文本正文
      out = { body: bodyRaw };
    }
  } catch (e) {
    if (e instanceof LlmNotConfiguredError) return demo;
    const msg = (e as Error).message ?? "";
    if (/超时|timeout/i.test(msg)) {
      throw new Error("AI 生成超时（已超过 170 秒未返回）。建议减少配图种类后重试；若反复出现，请检查 LLM 服务状态");
    }
    throw e;
  }

  return {
    titles: (out.titles ?? []).filter((t) => typeof t === "string").slice(0, 5).concat(demo.titles).slice(0, 5),
    body: clampBody(stripFences(out.body?.trim() || demo.body)),
    tags: (out.tags ?? []).filter((t) => typeof t === "string").slice(0, 10).concat(demo.tags).slice(0, 10),
    images: imageKinds.flatMap((kind, i): GeneratedImage[] => {
      const fallback = demoSpec(kind, cat, shortTitle, code);
      const spec = { ...fallback, ...(llmSpecs[i] ?? {}), kind } as ImageSpec;
      // 代码/题目描述过长自动分页成多张卡
      if (kind === "code") return chunkCodeCards(spec as CodeSpec).map((s) => ({ kind, spec: s as ImageSpec }));
      if (kind === "problem") return chunkProblemCards(spec as ProblemSpec).map((s) => ({ kind, spec: s as ImageSpec }));
      return [{ kind, spec }];
    }),
    isDemo: false,
  };
}

/** 为已有笔记单独生成一张指定类型的配图 */
export async function generateImageSpec(
  kind: ImageKind,
  noteTitle: string,
  noteBody: string,
  userPrompt?: string,
  materialContent?: string,
): Promise<ImageSpec> {
  const fallback = demoSpec(kind, guessCategory(noteTitle + noteBody), noteTitle.slice(0, 8), extractBestCode(noteBody, materialContent));
  // 代码卡：代码本体从正文/素材本地提取，LLM 只补标题和复杂度（小输出，不会截断）
  if (kind === "code") {
    const cb = extractBestCode(noteBody, materialContent);
    if (cb) {
      const meta = await genCodeMeta(noteTitle, cb.code, userPrompt);
      return { kind, title: meta.title, lang: cb.lang, code: cb.code, note: meta.note, theme: "dark" } as ImageSpec;
    }
  }
  // 题目描述卡：直接用素材/正文原文——先纯本地切题面（零 token、不改写），失败再让 LLM 输出首尾锚点辅助切片
  if (kind === "problem") {
    const src = materialContent ?? noteBody;
    const text = extractProblemTextLocal(src) ?? (await locateProblemText(src));
    if (text) return { kind, title: "题目描述", text, theme: "blue" } as ImageSpec;
  }
  let raw: string;
  try {
    raw = await chatCompletion(
      [
        { role: "system", content: IMAGE_SPEC_SYSTEM },
        { role: "user", content: buildImageGenPrompt(kind, noteTitle, noteBody, userPrompt) },
      ],
      { temperature: 0.7, maxTokens: 16000 },
    );
  } catch (e) {
    if (e instanceof LlmNotConfiguredError) return fallback;
    throw e;
  }
  try {
    const out = extractJson<Partial<ImageSpec>>(raw);
    return { ...fallback, ...out, kind } as ImageSpec;
  } catch {
    return fallback;
  }
}

export type ImagePlan = { name: string; desc: string; prompt: string };

/** 路线 A：LLM 读笔记正文，产出 3 个 AI 生图画面方案 */
export async function generateImagePlans(
  noteTitle: string,
  noteBody: string,
  mode: "illustration" | "infographic",
): Promise<ImagePlan[]> {
  const persona = await getPersonaPrompt();
  const raw = await chatCompletion(
    [
      { role: "system", content: persona },
      { role: "user", content: buildImagePlanPrompt(noteTitle, noteBody, mode) },
    ],
    { temperature: 0.9, maxTokens: 12000, timeoutMs: 170_000 },
  );
  const out = extractJson<{ plans?: { name?: string; desc?: string; prompt?: string }[] }>(raw);
  const plans = (out.plans ?? [])
    .filter((p) => typeof p.prompt === "string" && p.prompt.trim().length >= 10)
    .slice(0, 3)
    .map((p) => ({
      name: (p.name ?? "方案").slice(0, 12),
      desc: (p.desc ?? "").slice(0, 40),
      prompt: p.prompt!.trim().slice(0, 500),
    }));
  if (plans.length === 0) throw new Error("AI 没有产出可用方案，请重试或直接手写画面描述");
  return plans;
}

/** 按用户一句话指令微调 AI 生图的画面描述，返回修订后的完整描述（仅回填前端，不落库） */
export async function refineImagePrompt(
  prompt: string,
  instruction: string,
  mode: "illustration" | "infographic",
): Promise<string> {
  const modeHint =
    mode === "infographic"
      ? "这是「内容信息图」的描述：图中的文字内容必须保留且准确，不要删减信息点。"
      : "这是「氛围插画」的描述：画面里一般不出现文字。";
  const raw = await chatCompletion(
    [
      {
        role: "system",
        content:
          "你是小红书笔记配图的文生图提示词助手。用户给出当前画面描述和一句修改意见，你输出修改后的完整画面描述。要求：只输出描述本身，不要解释、不要加引号；保留原描述中未被修改意见否定的信息；描述具体、可直接用于文生图；总长不超过 180 字。" +
          modeHint,
      },
      {
        role: "user",
        content: `当前画面描述：\n${prompt.trim()}\n\n修改意见：${instruction.trim()}\n\n请输出修改后的完整画面描述：`,
      },
    ],
    { temperature: 0.7, maxTokens: 6000, timeoutMs: 120_000 },
  );
  const out = raw.trim().replace(/^["「『]+|["」』]+$/g, "");
  if (out.length < 4) throw new Error("AI 微调结果为空，请换个表述重试");
  return out.slice(0, 500);
}

/** 按用户指令改写笔记正文，返回改写后的全文 */
export async function rewriteBody(noteTitle: string, body: string, instruction: string): Promise<string> {
  const persona = await getPersonaPrompt();
  const raw = await chatCompletion(
    [
      { role: "system", content: persona },
      { role: "user", content: buildRewritePrompt(noteTitle, body, instruction) },
    ],
    { temperature: 0.7, maxTokens: 8000, timeoutMs: 170_000 },
  );
  const trimmed = raw.trim();
  if (trimmed.length < 50) throw new Error("AI 改写结果过短，请换个表述重试");
  return clampBody(trimmed);
}

/** 重新生成候选标题 */
export async function regenerateTitles(materialTitle: string, currentTitles: string[]): Promise<string[]> {
  const persona = await getPersonaPrompt();
  const raw = await chatCompletion(
    [
      { role: "system", content: persona },
      { role: "user", content: buildTitlePrompt(materialTitle, currentTitles) },
    ],
    { temperature: 0.9, maxTokens: 3000 },
  );
  const out = extractJson<{ titles?: string[] }>(raw);
  return (out.titles ?? []).filter((t) => typeof t === "string").slice(0, 5);
}

// ============ 质检 ============

const HARD_FORBIDDEN = ["加微信", "微信号", "扫码", "v：", "V：", "兼职", "刷单", "免费领取"];
const SOFT_WARN = ["全网最全", "全网第一", "史上", "100%", " guaranteed"];

function charLen(s: string): number {
  return [...s].length;
}

/** 小红书正文硬上限：850 字（不含标签）。超出时按段落边界截断，并补全未闭合的代码块，避免上传被平台硬截 */
export const BODY_MAX_LEN = 850;

/** 剥掉正文里的围栏代码块（代码由代码卡呈现），并收敛多余空行 */
function stripFences(t: string): string {
  return t.replace(/```[\s\S]*?```/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function clampBody(body: string, max = BODY_MAX_LEN): string {
  if (charLen(body) <= max) return body;
  // 逐行累加，保留能放得下的完整段落；尽量保住末句互动钩子
  const lines = body.split("\n");
  let out = "";
  const tailIdx = (() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim()) return i;
    }
    return -1;
  })();
  if (tailIdx > 0) {
    const tail = lines[tailIdx];
    const budget = max - charLen(tail) - 1;
    if (budget > 0) {
      const kept2: string[] = [];
      let used2 = 0;
      for (const line of lines.slice(0, tailIdx)) {
        const cost = charLen(line) + (kept2.length > 0 ? 1 : 0);
        if (used2 + cost > budget) break;
        kept2.push(line);
        used2 += cost;
      }
      if (kept2.length > 0) out = kept2.join("\n") + "\n" + tail;
    }
  }
  if (!out) {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      const cost = charLen(line) + (kept.length > 0 ? 1 : 0); // +1 换行
      if (used + cost > max) break;
      kept.push(line);
      used += cost;
    }
    out = kept.join("\n").trimEnd();
    if (!out) out = [...body].slice(0, max).join(""); // 首行就超长（罕见），硬截
  }
  // 未闭合的代码块补一个 ```
  const fences = (out.match(/```/g) ?? []).length;
  if (fences % 2 === 1 && charLen(out) + 4 <= max) out += "\n```";
  return out;
}

export function runQc(note: { title: string; body: string; tags: string[] }): QcItem[] {
  const items: QcItem[] = [];

  items.push(
    charLen(note.title) <= 20
      ? { level: "pass", item: "标题长度", message: `${charLen(note.title)} 字，符合 ≤20 字要求` }
      : { level: "fail", item: "标题长度", message: `${charLen(note.title)} 字，超出 20 字上限，会被截断` },
  );

  const bodyLen = charLen(note.body);
  items.push(
    bodyLen <= BODY_MAX_LEN
      ? { level: "pass", item: "正文长度", message: `${bodyLen} 字，符合 ≤${BODY_MAX_LEN} 字要求` }
      : { level: "fail", item: "正文长度", message: `${bodyLen} 字，超出 ${BODY_MAX_LEN} 字上限，上传小红书会被截断，请精简` },
  );

  const hard = HARD_FORBIDDEN.filter((w) => note.body.includes(w) || note.title.includes(w));
  items.push(
    hard.length === 0
      ? { level: "pass", item: "引流合规", message: "未发现硬引流词" }
      : { level: "fail", item: "引流合规", message: `发现高风险词：${hard.join("、")}，小红书对此类内容限流/封号风险高` },
  );

  const soft = SOFT_WARN.filter((w) => note.body.includes(w) || note.title.includes(w));
  items.push(
    soft.length === 0
      ? { level: "pass", item: "广告法用词", message: "未发现绝对化用语" }
      : { level: "warn", item: "广告法用词", message: `建议复核：${soft.join("、")}` },
  );

  items.push(
    /```[\s\S]*```/.test(note.body)
      ? { level: "warn", item: "代码块", message: "正文残留代码块，建议删除，代码由代码卡呈现" }
      : { level: "pass", item: "代码块", message: "正文无代码块，由代码卡呈现" },
  );

  items.push(
    (() => {
      const tail = [...note.body].slice(-60).join("");
      return /[\uFF1F?\u5417\u5462]|\u8BC4\u8BBA\u533A/.test(tail) && /\u5173\u6CE8|\u8FFD\u66F4/.test(tail)
        ? { level: "pass", item: "末句钩子", message: "末句含完整互动钩子" }
        : { level: "warn", item: "末句钩子", message: "末句缺少完整互动钩子（提问+关注引导）" };
    })(),
  );

  items.push(
    note.tags.length >= 5
      ? { level: "pass", item: "标签数量", message: `${note.tags.length} 个标签` }
      : { level: "warn", item: "标签数量", message: `只有 ${note.tags.length} 个标签，建议 8-10 个` },
  );

  const paras = note.body.split("\n").filter((l) => l.trim());
  items.push(
    paras.length >= 8
      ? { level: "pass", item: "段落结构", message: `${paras.length} 个段落，适合手机阅读` }
      : { level: "warn", item: "段落结构", message: "段落偏少，建议拆分短段落" },
  );

  return items;
}

// ============ 素材骨架提取 + 创作角度（未配置 LLM 时给演示骨架） ============

export type Outline = { skeleton: string; angles: OutlineAngle[] };

function demoOutline(title: string, content: string): Outline {
  const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
  const heads = lines.filter((l) => /^#{1,3}\s|^\d+[.、)]\s*\S{2,24}$/.test(l)).slice(0, 6);
  const topics = (heads.length ? heads : lines.slice(0, 5)).map((l) => l.replace(/^#+\s*/, "").slice(0, 24));
  const skeleton = ["## 素材概览", `- 主题：${title.slice(0, 30)}`, ...topics.map((t) => `- ${t}`)].join("\n");
  const cat = guessCategory(title + content);
  return {
    skeleton,
    angles: [
      { name: "思路精讲", focus: `面向新手讲清${cat}的核心思路和推导过程`, why: "新手向内容受众最广" },
      { name: "模板套路", focus: `把本题抽象成可复用的${cat}模板，总结答题套路`, why: "收藏率高" },
      { name: "易错避坑", focus: "聚焦边界条件和常见错误写法", why: "痛点内容评论多" },
      { name: "复杂度优化", focus: "从暴力解逐步优化到最优解", why: "体现实力，面试加分" },
    ],
  };
}

/** LLM 通读素材 → 骨架 + 4 个创作角度（一次调用，控制在 52 秒内） */
export async function extractOutline(materialTitle: string, content: string): Promise<Outline> {
  try {
    // LLM 输出的 JSON 偶发被截断/夹杂文本导致解析失败：SyntaxError 自动重试一次
    let out: { skeleton?: string; angles?: { name?: string; focus?: string; why?: string }[] } | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await chatCompletion(
          [
            { role: "system", content: await getPersonaPrompt() },
            { role: "user", content: buildSkeletonPrompt(materialTitle, content) },
          ],
          { temperature: 0.7, maxTokens: 12000, timeoutMs: 170_000 },
        );
        out = extractJson<{ skeleton?: string; angles?: { name?: string; focus?: string; why?: string }[] }>(raw);
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
    if (!out) throw lastErr;
    const skeleton = (out.skeleton ?? "").trim();
    if (!skeleton) throw new Error("骨架为空");
    const angles = (out.angles ?? [])
      .filter((a) => typeof a.name === "string" && a.name.trim() && typeof a.focus === "string" && a.focus.trim())
      .slice(0, 5)
      .map((a) => ({
        name: a.name!.trim().slice(0, 12),
        focus: a.focus!.trim().slice(0, 60),
        why: (a.why ?? "").trim().slice(0, 30),
      }));
    return { skeleton, angles: angles.length ? angles : demoOutline(materialTitle, content).angles };
  } catch (e) {
    if (e instanceof LlmNotConfiguredError) return demoOutline(materialTitle, content);
    throw e;
  }
}

/** 按用户一句话要求微调骨架 */
export async function refineSkeleton(skeleton: string, instruction: string): Promise<string> {
  const raw = await chatCompletion(
    [{ role: "user", content: buildSkeletonRefinePrompt(skeleton, instruction) }],
    { temperature: 0.5, maxTokens: 12000, timeoutMs: 170_000 },
  );
  // 去掉 LLM 可能包裹的 markdown 代码围栏
  return raw.trim().replace(/^```(?:markdown|md)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
}
