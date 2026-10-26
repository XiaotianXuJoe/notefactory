/**
 * 叙事工坊：小红书小号叙事笔记初稿流水线（选题 → AI 初稿 → 微调 → 金句卡）
 * 从旧 public/narrative.html 移植；业务数据只存服务器（narrative.state / narrative.style），
 * 编辑防抖 600ms 自动保存，页面加载以服务器数据为唯一数据源。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import DraftSection from "@/components/narrative/DraftSection";
import QuoteCardSection, { type CardCfg } from "@/components/narrative/QuoteCardSection";
import StylePanel, { type StylePatch } from "@/components/narrative/StylePanel";
import {
  DEFAULT_PROMPT,
  describeLlmConfig,
  getNstyleInject,
  normalizeCard,
  normalizeDraft,
  type ChatMessage,
  type NarrativeDraft,
  type StyleSample,
} from "@/components/narrative/prompts";

type StatePatch = {
  prompt?: string;
  type?: string;
  goal?: string;
  topic?: string;
  material?: string;
  draft?: Record<string, unknown> | null;
  card?: Record<string, unknown> | null;
};

/** 合并补丁 + 防抖推送（旧页 localStorage 包装 + 600ms debounce 的等价物） */
function useDebouncedSaver<T extends object>(mutate: (v: T) => void, delay = 600) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<T>>({});
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  return useCallback(
    (patch: Partial<T>) => {
      pending.current = { ...pending.current, ...patch };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const p = pending.current;
        pending.current = {};
        mutateRef.current(p as T);
      }, delay);
    },
    [delay],
  );
}

export default function Narrative() {
  const stateQ = trpc.narrative.state.get.useQuery();
  const styleQ = trpc.narrative.style.get.useQuery();
  const cfgQ = trpc.narrative.chatConfig.useQuery();

  const saveWarned = useRef(false);
  const onSaveError = useCallback((e: { message: string }) => {
    if (saveWarned.current) return;
    saveWarned.current = true;
    toast.error("自动保存失败：" + e.message);
  }, []);
  const stateUpd = trpc.narrative.state.update.useMutation({ onError: onSaveError });
  const styleUpd = trpc.narrative.style.update.useMutation({ onError: onSaveError });
  const chatMut = trpc.narrative.chat.useMutation();

  /* ---------- 本地工作区（服务器数据为唯一数据源，到达后初始化一次） ---------- */
  const [stateInit, setStateInit] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [noteType, setNoteType] = useState("");
  const [noteGoal, setNoteGoal] = useState("");
  const [topic, setTopic] = useState("");
  const [material, setMaterial] = useState("");
  const [draft, setDraft] = useState<NarrativeDraft | null>(null);
  const [card, setCard] = useState<CardCfg>({ quote: "", sign: "闭着眼睛整点薯条🍟", theme: "paper" });

  const [styleInit, setStyleInit] = useState(false);
  const [samples, setSamples] = useState<StyleSample[]>([]);
  const [profile, setProfile] = useState("");
  const [nstyleEnabled, setNstyleEnabled] = useState(false);
  const [nstylePrompt, setNstylePrompt] = useState("");

  const [promptOpen, setPromptOpen] = useState(false);
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const cardPreviewRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const d = stateQ.data;
    if (!d || stateInit) return;
    setPrompt(d.prompt || "");
    setNoteType(d.type || "");
    setNoteGoal(d.goal || "");
    setTopic(d.topic || "");
    setMaterial(d.material || "");
    setDraft(normalizeDraft(d.draft));
    setCard(normalizeCard(d.card));
    setStateInit(true);
  }, [stateQ.data, stateInit]);

  useEffect(() => {
    const d = styleQ.data;
    if (!d || styleInit) return;
    setSamples(Array.isArray(d.samples) ? d.samples : []);
    setProfile(d.profile || "");
    setNstyleEnabled(!!d.enabled);
    setNstylePrompt(d.prompt || "");
    setStyleInit(true);
  }, [styleQ.data, styleInit]);

  const saveState = useDebouncedSaver<StatePatch>((p) => stateUpd.mutate(p));
  const saveStyle = useDebouncedSaver<StylePatch>((p) => styleUpd.mutate(p));

  /* ---------- LLM 调用（旧页 nchatCompletion / ensureNchatReady） ---------- */
  const chatComplete = useCallback(
    async (messages: ChatMessage[], maxTokens = 4096): Promise<string> => {
      try {
        const r = await chatMut.mutateAsync({ messages, maxTokens });
        if (typeof r.text !== "string" || !r.text.trim()) throw new Error("模型返回了空内容，请重试");
        return r.text;
      } catch (e) {
        const msg = (e as Error).message || "模型代理请求失败";
        if (/未配置 LLM API Key/.test(msg)) cfgQ.refetch();
        throw new Error(msg);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatMut],
  );

  const ensureLlmReady = useCallback((): boolean => {
    if (cfgQ.data?.configured) return true;
    cfgQ.refetch();
    if (cfgQ.isError) toast.error("无法连接模型代理：" + (cfgQ.error as { message?: string } | null)?.message);
    else toast.error("请先在主站「设置」页配置 LLM API Key");
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfgQ.data, cfgQ.isError]);

  /* ---------- 各区块变更回调 ---------- */
  const onFieldChange = useCallback(
    (patch: { type?: string; goal?: string; topic?: string; material?: string }) => {
      if (patch.type !== undefined) setNoteType(patch.type);
      if (patch.goal !== undefined) setNoteGoal(patch.goal);
      if (patch.topic !== undefined) setTopic(patch.topic);
      if (patch.material !== undefined) setMaterial(patch.material);
      saveState(patch);
    },
    [saveState],
  );

  const onDraftChange = useCallback(
    (d: NarrativeDraft | null) => {
      setDraft(d);
      saveState({ draft: d as unknown as Record<string, unknown> | null });
    },
    [saveState],
  );

  const onCardChange = useCallback(
    (c: CardCfg) => {
      setCard(c);
      saveState({ card: c as unknown as Record<string, unknown> });
    },
    [saveState],
  );

  const onStyleChange = useCallback(
    (patch: StylePatch) => {
      if (patch.samples !== undefined) setSamples(patch.samples);
      if (patch.profile !== undefined) setProfile(patch.profile);
      if (patch.enabled !== undefined) setNstyleEnabled(patch.enabled);
      if (patch.prompt !== undefined) setNstylePrompt(patch.prompt);
      saveStyle(patch);
    },
    [saveStyle],
  );

  const onSendToCard = useCallback(
    (quote: string) => {
      const next = { ...card, quote };
      setCard(next);
      saveState({ card: next as unknown as Record<string, unknown> });
      toast.success("已送入金句卡");
      cardPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [card, saveState],
  );

  const onClearCache = useCallback(() => {
    const hasData = draft || topic.trim() || material.trim();
    if (
      hasData &&
      !confirm("确定要清空全部缓存吗？\n将删除本页保存的选题、素材和初稿（不影响小号风格档案），此操作不可恢复。")
    )
      return;
    setNoteType("");
    setNoteGoal("");
    setTopic("");
    setMaterial("");
    setDraft(null);
    saveState({ type: "", goal: "", topic: "", material: "", draft: null });
    setCacheEpoch((e) => e + 1); // 重置微调输入与 lastGenRequest
    toast.success("缓存已清空，可以开始新的选题");
  }, [draft, topic, material, saveState]);

  /* ---------- 模型横幅 ---------- */
  const banner = (() => {
    if (cfgQ.isLoading)
      return { kind: "warn" as const, text: "模型配置：正在读取主站设置..." };
    if (cfgQ.isError)
      return { kind: "warn" as const, text: "模型配置读取失败：" + (cfgQ.error as { message?: string } | null)?.message };
    const c = cfgQ.data;
    if (!c?.configured)
      return { kind: "warn" as const, text: "主站未配置 LLM API Key：请到主站「设置」页完成配置" };
    return { kind: "ok" as const, text: "模型已与主站统一：" + describeLlmConfig(c) };
  })();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900">叙事工坊</h1>
        <p className="mt-1 text-sm text-stone-500">
          小红书小号「闭着眼睛整点薯条🍟」叙事笔记初稿流水线：选题 → AI 初稿 → 微调 → 金句卡
        </p>
      </div>

      {/* 模型状态横幅 */}
      <div
        className={`flex items-center justify-between gap-3 rounded-lg border px-3.5 py-2.5 text-[13px] ${
          banner.kind === "ok"
            ? "border-green-200 bg-green-50 text-green-800"
            : "border-amber-200 bg-amber-50 text-amber-800"
        }`}
      >
        <span>
          <strong className="font-semibold">{banner.text.split("：")[0]}</strong>
          {banner.text.includes("：") ? "：" + banner.text.split("：").slice(1).join("：") : ""}
        </span>
        <Link to="/settings" className="shrink-0 text-orange-700 underline decoration-orange-300 underline-offset-2">
          打开主站设置
        </Link>
      </div>

      {/* 系统提示词（折叠） */}
      <Card>
        <Collapsible open={promptOpen} onOpenChange={setPromptOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-6 py-4 text-left text-base font-semibold">
            <span className="flex-1">系统提示词（点击展开/折叠）</span>
            <ChevronDown className={`h-4 w-4 text-stone-400 transition-transform ${promptOpen ? "" : "-rotate-90"}`} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-2 pt-0">
              <Textarea
                className="min-h-[160px] text-[13px] leading-7"
                value={prompt === "" ? DEFAULT_PROMPT : prompt}
                onChange={(e) => {
                  const v = e.target.value === DEFAULT_PROMPT ? "" : e.target.value;
                  setPrompt(v);
                  saveState({ prompt: v });
                }}
              />
              <div>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPrompt("");
                    saveState({ prompt: "" });
                    toast.success("已恢复默认提示词");
                  }}
                >
                  恢复默认
                </Button>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      <DraftSection
        key={cacheEpoch}
        noteType={noteType}
        noteGoal={noteGoal}
        topic={topic}
        material={material}
        onFieldChange={onFieldChange}
        draft={draft}
        onDraftChange={onDraftChange}
        systemPrompt={prompt === "" ? DEFAULT_PROMPT : prompt}
        styleInject={getNstyleInject(nstyleEnabled, profile)}
        chatComplete={chatComplete}
        ensureLlmReady={ensureLlmReady}
        onSendToCard={onSendToCard}
        onClearCache={onClearCache}
        styleSlot={
          <StylePanel
            samples={samples}
            profile={profile}
            enabled={nstyleEnabled}
            stylePrompt={nstylePrompt}
            onStyleChange={onStyleChange}
            chatComplete={chatComplete}
            ensureLlmReady={ensureLlmReady}
          />
        }
      />

      <QuoteCardSection card={card} onChange={onCardChange} previewRef={cardPreviewRef} />
    </div>
  );
}
