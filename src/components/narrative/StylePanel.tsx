/**
 * 叙事工坊：小号风格档案（2）—— 样本库 / 风格分析 / 档案编辑 / 提取提示词
 * 逻辑对齐旧 public/narrative.html 的 nstyle 区块；数据经 style.update 局部字段持久化。
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DEFAULT_NSTYLE_PROMPT,
  N_MAX_SAMPLES,
  N_PER_SAMPLE_CHARS,
  buildStyleAnalysisUserContent,
  guessSampleName,
  type ChatMessage,
  type StyleSample,
} from "./prompts";
import { copyText, renderMarkdown } from "./utils";
import { NumIcon } from "./DraftSection";

export type StylePatch = {
  samples?: StyleSample[];
  profile?: string;
  enabled?: boolean;
  prompt?: string;
};

type Props = {
  samples: StyleSample[];
  profile: string;
  enabled: boolean;
  stylePrompt: string; // '' = 使用默认
  onStyleChange: (patch: StylePatch) => void;
  chatComplete: (messages: ChatMessage[], maxTokens?: number) => Promise<string>;
  ensureLlmReady: () => boolean;
};

const EMPTY_PROFILE_HINT = (
  <div className="flex min-h-[150px] flex-col items-center justify-center gap-2 px-5 py-8 text-center text-stone-400">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
    <div className="text-sm font-medium text-stone-500">小号风格档案将显示在这里</div>
    <div className="text-xs">先导入若干篇小号笔记，再点击「分析样本并生成风格档案」</div>
  </div>
);

export default function StylePanel(props: Props) {
  const { samples, profile, enabled, onStyleChange } = props;
  const [open, setOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [sampleTitle, setSampleTitle] = useState("");
  const [articleInput, setArticleInput] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [profileTab, setProfileTab] = useState<"rendered" | "source">("rendered");
  const [renderedMd, setRenderedMd] = useState(profile);
  const [sourceDraft, setSourceDraft] = useState(profile);

  // 服务器档案到达/更新后同步本地视图
  useEffect(() => {
    setRenderedMd(profile);
    setSourceDraft(profile);
  }, [profile]);

  const hasProfile = !!profile.trim();
  const effPrompt = props.stylePrompt || DEFAULT_NSTYLE_PROMPT;
  const totalChars = samples.reduce((a, s) => a + s.text.length, 0);

  function addSample() {
    const text = articleInput.trim();
    if (!text) { toast("请先粘贴笔记内容"); return; }
    if (text.length > N_PER_SAMPLE_CHARS) {
      toast.error("单篇笔记过长（上限 " + N_PER_SAMPLE_CHARS + " 字符）");
      return;
    }
    if (samples.length >= N_MAX_SAMPLES) { toast.error("样本库已满（上限 " + N_MAX_SAMPLES + " 篇）"); return; }
    if (samples.some((s) => s.text === text)) { toast.error("该笔记已在样本库中"); return; }
    onStyleChange({ samples: [...samples, { name: sampleTitle.trim() || guessSampleName(text), text }] });
    setSampleTitle("");
    setArticleInput("");
    toast.success("已添加到样本库");
  }

  function deleteSample(idx: number) {
    onStyleChange({ samples: samples.filter((_, i) => i !== idx) });
    toast.success("已删除该样本");
  }

  function toggleNstyle(on: boolean) {
    onStyleChange({ enabled: on });
    toast.success(on ? "已启用小号风格模仿" : "已停用小号风格模仿");
  }

  async function analyzeNstyle() {
    if (!samples.length) { toast("样本库为空，请先导入小号笔记"); return; }
    if (!props.ensureLlmReady()) return;
    setAnalyzing(true);
    try {
      const userContent = buildStyleAnalysisUserContent(samples);
      const result = await props.chatComplete(
        [
          { role: "system", content: effPrompt },
          { role: "user", content: userContent },
        ],
        4096,
      );
      const md = result.trim();
      onStyleChange({ profile: md });
      setRenderedMd(md);
      setProfileTab("rendered");
      toast.success("小号风格档案已生成" + (enabled ? "，生成初稿时将自动模仿" : "，勾选上方开关即可启用"));
    } catch (e) {
      toast.error("错误: " + (e as Error).message);
      console.error(e);
    } finally {
      setAnalyzing(false);
    }
  }

  function saveProfile() {
    const md = sourceDraft.trim();
    if (!md) { toast("档案内容为空"); return; }
    onStyleChange({ profile: md });
    setRenderedMd(md);
    toast.success("小号风格档案已保存，生成初稿时生效");
  }

  function copyProfile() {
    if (!profile) { toast("没有内容可复制"); return; }
    copyText(profile, "已复制到剪贴板");
  }

  function clearNstyleCache() {
    const hasData = samples.length > 0 || hasProfile;
    if (
      hasData &&
      !confirm("确定要清空小号风格数据吗？\n将删除小号样本库与风格档案（不影响大号风格学习页的数据），此操作不可恢复。")
    )
      return;
    onStyleChange({ samples: [], profile: "", enabled: false, prompt: "" });
    setSampleTitle("");
    setArticleInput("");
    setProfileTab("rendered");
    toast.success("小号风格数据已清空");
  }

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-6 py-4 text-left text-base font-semibold">
          <NumIcon n="2" />
          <span className="flex-1">小号风格档案（可选 · 让 AI 模仿你小号的叙事语气）</span>
          <ChevronDown className={`h-4 w-4 text-stone-400 transition-transform ${open ? "" : "-rotate-90"}`} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-4 pt-0">
            <div className="flex flex-wrap items-center gap-2.5 text-[13px] text-stone-600">
              <span className="inline-flex items-center gap-2 font-medium text-stone-900">
                <Switch checked={enabled && hasProfile} disabled={!hasProfile} onCheckedChange={toggleNstyle} />
                生成初稿时模仿小号叙事风格
              </span>
              {!hasProfile ? (
                <span className="text-xs text-stone-400">尚无小号风格档案，导入样本后生成</span>
              ) : enabled ? (
                <span className="text-xs text-green-600">已启用 · 初稿将注入小号风格档案</span>
              ) : (
                <span className="text-xs text-stone-400">未启用</span>
              )}
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber-800">
              粘贴小号过往的笔记全文（建议 3-5 篇数据好的），分析出专属叙事风格档案。该档案与大号「风格学习」页的题解风格
              <strong>互相独立</strong>，数据同样保存在服务器。
            </div>
            <div className="space-y-1.5">
              <Label>导入小号笔记</Label>
              <Input
                placeholder="样本标题（可选，留空自动从首行推断）"
                maxLength={60}
                value={sampleTitle}
                onChange={(e) => setSampleTitle(e.target.value)}
              />
              <Textarea
                className="min-h-[190px] leading-7"
                placeholder="在此粘贴一篇小号已发布的笔记全文（标题+正文+标签）..."
                value={articleInput}
                onChange={(e) => setArticleInput(e.target.value)}
              />
            </div>
            <div>
              <Button onClick={addSample} className="bg-orange-600 hover:bg-orange-700">
                添加到样本库
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {samples.length === 0 ? (
                <div className="rounded-lg border border-dashed border-stone-300 p-5 text-center text-[13px] text-stone-400">
                  样本库为空，粘贴小号笔记后点击「添加到样本库」
                </div>
              ) : (
                samples.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-lg border border-stone-200 bg-white px-3 py-2.5"
                  >
                    <span className="flex-1 truncate text-[13.5px] font-medium">{s.name || "未命名笔记"}</span>
                    <span className="shrink-0 text-xs text-stone-400">{s.text.length} 字符</span>
                    <button
                      type="button"
                      onClick={() => deleteSample(i)}
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-stone-400 hover:bg-red-100 hover:text-red-600"
                    >
                      删除
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 font-mono text-xs text-stone-600">
                共 {samples.length} 篇 · {totalChars} 字符
              </span>
            </div>
            <div>
              <Button onClick={analyzeNstyle} disabled={analyzing} className="bg-orange-600 hover:bg-orange-700">
                {analyzing && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                {analyzing ? "分析中..." : "分析样本并生成风格档案"}
              </Button>
            </div>
            <Tabs
              value={profileTab}
              onValueChange={(v) => {
                const tab = v as "rendered" | "source";
                if (tab === "rendered") {
                  if (sourceDraft !== profile) setRenderedMd(sourceDraft);
                } else {
                  setSourceDraft(profile);
                }
                setProfileTab(tab);
              }}
            >
              <TabsList>
                <TabsTrigger value="rendered">渲染预览</TabsTrigger>
                <TabsTrigger value="source">编辑档案源码</TabsTrigger>
              </TabsList>
              <TabsContent value="rendered">
                {renderedMd.trim() ? (
                  <div
                    className="md-preview text-sm leading-8"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(renderedMd) }}
                  />
                ) : (
                  EMPTY_PROFILE_HINT
                )}
              </TabsContent>
              <TabsContent value="source">
                <Textarea
                  className="min-h-[220px] leading-7"
                  placeholder="可在此直接编辑风格档案 Markdown，编辑后点击「保存档案」生效"
                  value={sourceDraft}
                  onChange={(e) => setSourceDraft(e.target.value)}
                />
              </TabsContent>
            </Tabs>
            <div className="flex flex-wrap gap-2.5">
              <Button variant="secondary" onClick={saveProfile}>
                保存档案
              </Button>
              <Button variant="secondary" onClick={copyProfile}>
                复制 Markdown
              </Button>
              <Button
                variant="outline"
                className="ml-auto border-red-200 text-red-600 hover:bg-red-50 hover:text-red-600"
                onClick={clearNstyleCache}
              >
                清空风格数据
              </Button>
            </div>
            <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
              <CollapsibleTrigger className="flex items-center gap-1.5 pt-1 text-sm font-semibold text-stone-900">
                档案提取提示词（点击展开/折叠）
                <ChevronDown className={`h-3.5 w-3.5 text-stone-400 transition-transform ${promptOpen ? "" : "-rotate-90"}`} />
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-2">
                <Textarea
                  className="min-h-[120px] text-[13px] leading-7"
                  value={props.stylePrompt === "" ? DEFAULT_NSTYLE_PROMPT : props.stylePrompt}
                  onChange={(e) =>
                    onStyleChange({ prompt: e.target.value === DEFAULT_NSTYLE_PROMPT ? "" : e.target.value })
                  }
                />
                <div>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      onStyleChange({ prompt: "" });
                      toast.success("已恢复默认提示词");
                    }}
                  >
                    恢复默认
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
