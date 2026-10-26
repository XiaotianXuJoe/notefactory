/**
 * 叙事工坊：选题与素材（1）+ 生成初稿（3）+ 初稿结果（4）
 * 逻辑对齐旧 public/narrative.html：buildGenRequest / generateDraft / refineDraft / parseDraft。
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildGenRequest,
  buildRefineMessages,
  parseDraft,
  type ChatMessage,
  type NarrativeDraft,
} from "./prompts";
import { copyText, renderMarkdown } from "./utils";

export const NOTE_TYPE_OPTIONS = [
  { value: "人生叙事", label: "人生叙事（成长感悟、人生阶段复盘）" },
  { value: "创业记录", label: "创业记录（一人公司 build in public）" },
  { value: "开店实录", label: "开店实录（咖啡店经营日常）" },
  { value: "辅导视角", label: "辅导老师视角（求职、简历、面试观察）" },
  { value: "咖啡生活", label: "咖啡与生活（人设调味）" },
];

export const NOTE_GOAL_OPTIONS = [
  { value: "涨粉", label: "涨粉（情绪共鸣、转发收藏）" },
  { value: "互动", label: "互动（引导评论提问）" },
  { value: "转化", label: "转化（为大号/辅导业务种草）" },
];

export function NumIcon({ n }: { n: string }) {
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-stone-900 text-xs text-white">
      {n}
    </span>
  );
}

type Props = {
  noteType: string;
  noteGoal: string;
  topic: string;
  material: string;
  onFieldChange: (patch: { type?: string; goal?: string; topic?: string; material?: string }) => void;
  draft: NarrativeDraft | null;
  onDraftChange: (d: NarrativeDraft | null) => void;
  systemPrompt: string;
  styleInject: string;
  chatComplete: (messages: ChatMessage[], maxTokens?: number) => Promise<string>;
  ensureLlmReady: () => boolean;
  onSendToCard: (quote: string) => void;
  onClearCache: () => void;
  /** 插在「1 选题与素材」与「3 生成初稿」之间（2 小号风格档案） */
  styleSlot?: React.ReactNode;
};

export default function DraftSection(props: Props) {
  const { draft, onDraftChange } = props;
  const effType = props.noteType || NOTE_TYPE_OPTIONS[0].value;
  const effGoal = props.noteGoal || NOTE_GOAL_OPTIONS[0].value;
  const [busy, setBusy] = useState<"gen" | "refine" | null>(null);
  const [refineInput, setRefineInput] = useState("");
  const lastGenRequest = useRef(""); // 最近一次生成初稿的 user 消息（微调时复用）

  const genRequest = () =>
    buildGenRequest({
      type: effType,
      goal: effGoal,
      topic: props.topic.trim(),
      material: props.material.trim(),
      styleInject: props.styleInject,
    });

  async function generateDraft() {
    const topic = props.topic.trim();
    if (!topic) { toast("请先填写选题"); return; }
    if (!props.ensureLlmReady()) return;
    setBusy("gen");
    try {
      const req = genRequest();
      lastGenRequest.current = req;
      const raw = await props.chatComplete(
        [
          { role: "system", content: props.systemPrompt },
          { role: "user", content: req },
        ],
        8192,
      );
      const d = parseDraft(raw, (msg) => toast.error(msg));
      onDraftChange(d);
      toast.success("初稿已生成，请核对〔待补〕占位并替换为真实细节");
    } catch (e) {
      toast.error("错误: " + (e as Error).message);
      console.error(e);
    } finally {
      setBusy(null);
    }
  }

  async function refineDraft() {
    const instruction = refineInput.trim();
    if (!instruction) { toast("请先填写微调要求"); return; }
    if (!draft) { toast("请先生成初稿"); return; }
    if (!props.ensureLlmReady()) return;
    setBusy("refine");
    try {
      const msgs = buildRefineMessages({
        systemPrompt: props.systemPrompt,
        genRequest: lastGenRequest.current || genRequest(),
        currentDraft: draft,
        instruction,
      });
      const raw = await props.chatComplete(msgs, 8192);
      const d = parseDraft(raw, (msg) => toast.error(msg));
      // 微调保留用户已选标题的优先权：把当前选中标题放到备选首位
      if (draft.title && !d.titles.includes(draft.title)) d.titles.unshift(draft.title);
      onDraftChange(d);
      setRefineInput("");
      toast.success("已按微调重写");
    } catch (e) {
      toast.error("错误: " + (e as Error).message);
      console.error(e);
    } finally {
      setBusy(null);
    }
  }

  function pickTitle(t: string) {
    if (!draft) return;
    onDraftChange({ ...draft, title: t });
    toast.success("已选用该标题");
  }

  function copyFullNote() {
    if (!draft) return;
    const title = draft.title || "";
    const body = draft.body.trim();
    const tags = draft.tags.trim();
    if (!body) { toast("没有内容可复制"); return; }
    const full = (title ? title + "\n\n" : "") + body + (tags ? "\n\n" + tags : "");
    copyText(full, "已复制完整笔记");
  }

  function copyBody() {
    const body = (draft?.body || "").trim();
    if (!body) { toast("没有内容可复制"); return; }
    copyText(body, "已复制正文");
  }

  const bodyLen = (draft?.body || "").replace(/\s/g, "").length;
  const tagList = (draft?.tags || "").split(/\s+/).map((t) => t.trim()).filter(Boolean);

  return (
    <>
      {/* ---------- 1 选题与素材 ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <NumIcon n="1" />
            选题与素材
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>笔记类型</Label>
              <Select value={effType} onValueChange={(v) => props.onFieldChange({ type: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>发布目标</Label>
              <Select value={effGoal} onValueChange={(v) => props.onFieldChange({ goal: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_GOAL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>选题（一句话）</Label>
            <Input
              placeholder="例：博士落榜两年后，我后悔了吗"
              maxLength={80}
              value={props.topic}
              onChange={(e) => props.onFieldChange({ topic: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>真实细节素材</Label>
            <Textarea
              className="min-h-[190px] leading-7"
              placeholder={"写只有你知道的真实细节：具体数字、对话、场景、时间、心理活动……\n例：2023 年 6 月复旦面试被刷；那天在邯郸路走了两个小时；导师散伙饭上说的那句话是……"}
              value={props.material}
              onChange={(e) => props.onFieldChange({ material: e.target.value })}
            />
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800">
            真实感是小号内容的命：<strong>AI 只负责组织语言，具体细节必须由你提供</strong>
            。素材越具体（数字、对话、地名、时间），初稿越不像 AI 写的。缺少细节的位置 AI 会用〔待补〕占位，不会编造。
          </div>
        </CardContent>
      </Card>

      {props.styleSlot}

      {/* ---------- 3 生成初稿 ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <NumIcon n="3" />
            生成初稿
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Button
              onClick={generateDraft}
              disabled={busy !== null}
              className="bg-orange-600 hover:bg-orange-700"
            >
              {busy === "gen" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {busy === "gen" ? "生成中..." : "生成初稿"}
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label>AI 微调（对当前初稿不满意时，用自然语言描述修改方向）</Label>
            <div className="flex gap-2.5">
              <Input
                className="flex-1"
                placeholder="例：开头太平了，换一个更有画面感的场景切入；整体再口语化一点"
                value={refineInput}
                onChange={(e) => setRefineInput(e.target.value)}
              />
              <Button variant="secondary" onClick={refineDraft} disabled={busy !== null}>
                {busy === "refine" && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {busy === "refine" ? "重写中..." : "按微调重写"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ---------- 4 初稿结果 ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <NumIcon n="4" />
            初稿结果
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!draft || (!draft.body && !draft.titles.length) ? (
            <div className="flex min-h-[150px] flex-col items-center justify-center gap-2 px-5 py-8 text-center text-stone-400">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
              </svg>
              <div className="text-sm font-medium text-stone-500">初稿将显示在这里</div>
              <div className="text-xs">填写选题与素材后，点击「生成初稿」</div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label>标题备选（点击选用）</Label>
                <div className="flex flex-col gap-2">
                  {draft.titles.length ? (
                    draft.titles.map((t, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => pickTitle(t)}
                        className={`rounded-lg border px-3 py-2.5 text-left text-[13.5px] leading-6 transition-colors ${
                          t === draft.title
                            ? "border-orange-400 bg-orange-50 font-semibold text-orange-800"
                            : "border-stone-200 bg-white hover:border-orange-300"
                        }`}
                      >
                        {t}
                      </button>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed border-stone-300 p-5 text-center text-[13px] text-stone-400">
                      未解析到标题备选
                    </div>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>正文（可直接编辑，右侧统计小红书 1000 字上限）</Label>
                <Tabs defaultValue="edit">
                  <TabsList>
                    <TabsTrigger value="edit">编辑</TabsTrigger>
                    <TabsTrigger value="preview">预览</TabsTrigger>
                  </TabsList>
                  <TabsContent value="edit">
                    <Textarea
                      className="min-h-[300px] leading-7"
                      value={draft.body}
                      onChange={(e) => onDraftChange({ ...draft, body: e.target.value })}
                    />
                  </TabsContent>
                  <TabsContent value="preview">
                    <div
                      className="md-preview min-h-[300px] rounded-lg border border-stone-200 p-3.5 text-sm leading-8"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.body || "") }}
                    />
                  </TabsContent>
                </Tabs>
              </div>
              <div className="space-y-1.5">
                <Label>标签（空格分隔，发布时逐个选择添加）</Label>
                <Input
                  placeholder="#博士落榜 #一人公司 #创业记录"
                  value={draft.tags}
                  onChange={(e) => onDraftChange({ ...draft, tags: e.target.value })}
                />
                {tagList.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {tagList.map((t, i) => (
                      <span
                        key={i}
                        className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[12.5px] text-amber-800"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>金句（用于制作金句卡）</Label>
                <div className="flex gap-2.5">
                  <Input
                    className="flex-1"
                    value={draft.quote}
                    onChange={(e) => onDraftChange({ ...draft, quote: e.target.value })}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const q = (draft.quote || "").trim();
                      if (!q) { toast("初稿金句为空，请先在「初稿结果」中填写"); return; }
                      props.onSendToCard(q);
                    }}
                  >
                    送入金句卡
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2.5 pt-1">
                <Button variant="secondary" onClick={copyFullNote}>
                  复制完整笔记（标题+正文+标签）
                </Button>
                <Button variant="secondary" onClick={copyBody}>
                  仅复制正文
                </Button>
                <Button
                  variant="outline"
                  className="ml-auto border-red-200 text-red-600 hover:bg-red-50 hover:text-red-600"
                  onClick={props.onClearCache}
                >
                  清空全部缓存
                </Button>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <span
                  className={`rounded-full border px-2.5 py-0.5 font-mono text-xs ${
                    bodyLen > 1000
                      ? "border-red-200 bg-red-50 text-red-600"
                      : "border-stone-200 bg-stone-50 text-stone-600"
                  }`}
                >
                  正文 {bodyLen} 字{bodyLen > 1000 ? "（超出小红书 1000 字上限！）" : ""}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
