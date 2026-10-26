/**
 * 叙事工坊：提示词文案、生成请求构建、LLM 输出解析
 * 全部从旧 public/narrative.html 逐字移植，prompt 文案不可改动。
 */

export const DEFAULT_PROMPT = `你是小红书爆款叙事写手，为账号「闭着眼睛整点薯条🍟」撰写笔记初稿。

## 账号人设（写作视角）
- 985 本硕，前 Top3 高校科研助理，2023 年博士落榜（复旦）后创业
- 现在是算法辅导老师：带学生备战大厂/华为OD算法面试，也做简历与面试辅导
- 同时是独立开发者，一个人用 AI 工具做产品（刷题网站、简历辅导平台等）
- 在广州开了一家独立咖啡店
- 大号「闭着眼睛学数理化」做编程算法干货，小号这个账号讲大号不讲的：人生、创业、开店、真实日常
- 账号气质：松弛、自嘲、真诚，签名是「活着就是为了去码头整点薯条」

## 写法要求
- 第一人称，口语化，像跟朋友聊天；短段落，一段不超过三行
- 开头两句必须有钩子：一个具体场景、一个反常识结论、或一个悬念，禁止"今天想跟大家聊聊"式开场
- 多写场景和细节，少讲道理；有感悟也要从具体的事里长出来，不要鸡汤腔、不要说教
- 情绪克制真实，可以自嘲，不卖惨不煽情
- 正文 600-900 字（小红书上限 1000 字，留余量）；适度使用 emoji 调节奏，每段最多一个
- 段落之间空一行

## 铁律
- 只使用用户提供的真实细节，绝不编造数字、人名、对话、时间、地点
- 需要细节但用户没给的位置，用〔待补：需要什么内容〕占位，不要瞎写
- 禁止股票、投资、荐股类内容；禁止微信号、二维码、关注引导等导流话术（平台违规）
- 不写标题党骗点击，但标题要有让人停下来的理由

## 输出格式（严格遵守，不要输出任何额外说明）
【标题备选】
1. （不超过 20 字，带钩子）
2. （5 个备选，角度各不相同）
3.
4.
5.
【正文】
（笔记正文，不含标题、不含标签）
【标签】
#标签1 #标签2 #标签3（5-8 个，大词小词搭配，与内容强相关）
【金句】
（全篇最有传播力的一句话，30 字以内，可以直接做成封面卡片）`;

export const DEFAULT_NSTYLE_PROMPT = `你是中文社交媒体文风分析专家。用户会给你若干篇同一个小红书账号（叙事类小号）发布的笔记全文，请提炼这个账号的叙事风格档案。

## 分析维度
1. 开头方式：常用什么钩子（场景/悬念/反常识/提问）
2. 叙事结构：时间线/对比/递进/反转，段落节奏
3. 语气口吻：自称、口癖、自嘲方式、情绪浓度
4. 标志性表达：反复出现的句式、比喻、梗
5. 细节使用：数字、对话、场景描写的密度和方式
6. 结尾方式：如何收束、是否引导互动、怎么引导
7. 排版习惯：段落长度、空行、emoji 位置与频率
8. 标签习惯：数量、大小词搭配

## 输出要求
- 输出一份 Markdown 风格档案，分维度组织，每个维度给出 2-3 条可操作的具体规则，并附样本中的原句作为例证
- 档案是给 AI 写作时模仿用的，规则要具体可执行，避免"语言生动"这类空话
- 仅输出档案本身，不要额外解释`;

/* ---------- 常量（与旧页一致） ---------- */
export const N_MAX_SAMPLES = 10;
export const N_PER_SAMPLE_CHARS = 2500;

/* ---------- 类型 ---------- */
export type NarrativeDraft = {
  titles: string[];
  title: string;
  body: string;
  tags: string;
  quote: string;
  raw: string;
};

export type StyleSample = { name?: string; text: string };

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/* ---------- 风格档案注入（生成初稿时拼入 user 消息） ---------- */
export function getNstyleInject(enabled: boolean, profile: string): string {
  if (!enabled) return "";
  const p = (profile || "").trim();
  if (!p) return "";
  return '\n\n## 账号叙事风格档案（必须模仿）\n以下是这个账号过往笔记提炼出的风格档案。你生成的初稿必须在开头方式、叙事节奏、语气口吻、标志性表达、结尾方式上严格模仿该档案，读起来要像博主本人写的：\n' + p;
}

/* ---------- 初稿生成请求（旧页 buildGenRequest） ---------- */
export function buildGenRequest(input: {
  type: string;
  goal: string;
  topic: string;
  material: string;
  styleInject: string;
}): string {
  let msg = '请为一篇小红书笔记生成初稿。\n'
    + '笔记类型：' + input.type + '\n'
    + '发布目标：' + input.goal + '\n'
    + '选题：' + input.topic + '\n\n'
    + '以下是我提供的真实细节素材（只能使用这些细节，不足处用〔待补〕占位）：\n'
    + (input.material || '（本次未提供素材，请全部用〔待补〕占位关键细节，不要编造）');
  msg += input.styleInject;
  return msg;
}

/* ---------- 解析模型输出：严格标记 + 兜底（旧页 parseDraft） ---------- */
export function parseDraft(raw: string, onWarn?: (msg: string) => void): NarrativeDraft {
  const d: NarrativeDraft = { titles: [], title: '', body: '', tags: '', quote: '', raw };
  const mT = raw.match(/【标题备选】([\s\S]*?)(?=【正文】)/);
  const mB = raw.match(/【正文】([\s\S]*?)(?=【标签】|$)/);
  const mTag = raw.match(/【标签】([\s\S]*?)(?=【金句】|$)/);
  const mQ = raw.match(/【金句】([\s\S]*?)$/);
  if (mT) {
    d.titles = mT[1].split('\n')
      .map(l => l.replace(/^\s*\d+[.、)）]\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter(l => l && !l.startsWith('【'));
    d.title = d.titles[0] || '';
  }
  if (mB) d.body = mB[1].trim();
  if (mTag) {
    d.tags = mTag[1].split('\n').join(' ')
      .split(/\s+/).map(t => t.trim()).filter(Boolean)
      .map(t => t.startsWith('#') ? t : '#' + t)
      .join(' ');
  }
  if (mQ) {
    d.quote = (mQ[1].split('\n').map(l => l.trim()).filter(Boolean)[0] || '')
      .replace(/^[「"']+|[」"']+$/g, '');
  }
  if (!d.body) {
    // 模型没按格式输出：全文作为正文兜底，提示用户检查
    d.body = raw.replace(/【[^】]+】/g, '').trim();
    if (onWarn) setTimeout(() => onWarn('模型未完全按格式输出，已尽力解析，请检查各栏内容'), 60);
  }
  return d;
}

/* ---------- 把当前草稿序列化回标记格式（微调时作为上下文） ---------- */
export function serializeCurrentDraft(d: Pick<NarrativeDraft, "titles" | "title" | "body" | "tags" | "quote">): string {
  return '【标题备选】\n' + (d.title
      ? '1. ' + d.title
      : (d.titles || []).map((t, i) => (i + 1) + '. ' + t).join('\n'))
    + '\n【正文】\n' + d.body
    + '\n【标签】\n' + d.tags
    + '\n【金句】\n' + d.quote;
}

/* ---------- 微调消息（旧页 refineDraft） ---------- */
export function buildRefineMessages(input: {
  systemPrompt: string;
  genRequest: string;
  currentDraft: Pick<NarrativeDraft, "titles" | "title" | "body" | "tags" | "quote">;
  instruction: string;
}): ChatMessage[] {
  return [
    { role: 'system', content: input.systemPrompt },
    { role: 'user', content: input.genRequest },
    { role: 'assistant', content: serializeCurrentDraft(input.currentDraft) },
    { role: 'user', content: '请按以下要求修改上面的笔记，仍然严格按原格式（【标题备选】【正文】【标签】【金句】）完整输出全部内容：\n' + input.instruction },
  ];
}

/* ---------- 风格分析 user 消息（旧页 analyzeNstyle） ---------- */
export function buildStyleAnalysisUserContent(samples: StyleSample[]): string {
  const used = samples.slice(0, 5);
  return '以下是我的小红书账号的 ' + used.length + ' 篇已发布笔记'
    + (samples.length > used.length ? '（样本库共 ' + samples.length + ' 篇，取前 ' + used.length + ' 篇）' : '')
    + '，请按系统提示词要求提炼这个账号的叙事风格档案：\n\n'
    + used.map((s, i) => '【第 ' + (i + 1) + ' 篇：' + (s.name || '未命名笔记') + '】\n' + s.text.slice(0, N_PER_SAMPLE_CHARS)).join('\n\n');
}

/* ---------- 样本标题推断（旧页 guessName） ---------- */
export function guessSampleName(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const l of lines.slice(0, 5)) {
    const t = l.replace(/^#+\s*/, '').trim();
    if (t && t.length <= 60) return t;
  }
  return '未命名笔记';
}

/* ---------- 模型配置描述（旧页 describeLlmConfig） ---------- */
export function describeLlmConfig(cfg: { model?: string; disableThinking?: boolean; temperature?: number | null } | null | undefined): string {
  if (!cfg) return '未读取到配置';
  const think = cfg.disableThinking ? '非思考模式' : '思考模式';
  const temp = cfg.temperature === null || cfg.temperature === undefined ? '温度自动' : '温度 ' + cfg.temperature;
  return (cfg.model || '') + ' · ' + think + ' · ' + temp;
}

/* ---------- 服务器数据规范化 ---------- */
export function normalizeDraft(v: unknown): NarrativeDraft | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    titles: Array.isArray(o.titles) ? o.titles.filter((t): t is string => typeof t === 'string') : [],
    title: typeof o.title === 'string' ? o.title : '',
    body: typeof o.body === 'string' ? o.body : '',
    tags: typeof o.tags === 'string' ? o.tags : '',
    quote: typeof o.quote === 'string' ? o.quote : '',
    raw: typeof o.raw === 'string' ? o.raw : '',
  };
}

export function normalizeCard(v: unknown): { quote: string; sign: string; theme: string } {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    quote: typeof o.quote === 'string' ? o.quote : '',
    sign: typeof o.sign === 'string' ? o.sign : '闭着眼睛整点薯条🍟',
    theme: typeof o.theme === 'string' ? o.theme : 'paper',
  };
}
