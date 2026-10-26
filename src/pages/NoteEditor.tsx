import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import NoteImageCard, { __dirtySet } from "@/components/NoteImageCard";
import CodeImageGroup from "@/components/CodeImageGroup";
import ProblemImageGroup from "@/components/ProblemImageGroup";
import MaterialImagesPanel from "@/components/MaterialImagesPanel";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardCopy,
  FlaskConical,
  Loader2,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { DiagramSpec, ImageKind, QcItem } from "@contracts/types";
import { AI_STYLES, IMAGE_KIND_META } from "@contracts/types";
import { THEMES, dataUrlToBytes, downloadZip, renderDiagramCardSvg, renderImageSvg, svgToPngDataUrl, type ThemeName } from "@/components/imageRender";
import { Copy, Download, KeyRound, Lightbulb, Palette, Plus, Send, Sparkles, Wand2 } from "lucide-react";
import { friendlyApiError } from "@/lib/utils";

type AiMode = "illustration" | "infographic";
type ImagePlan = { name: string; desc: string; prompt: string };

export default function NoteEditor() {
  const { id } = useParams<{ id: string }>();
  const noteId = Number(id);
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // 有 AI 配图正在后台生成时，每 4 秒轮询一次，完成后自动出现
  const note = trpc.notes.get.useQuery(
    { id: noteId },
    {
      enabled: Number.isFinite(noteId),
      refetchInterval: (q) => {
        const imgs = q.state.data?.images ?? [];
        return imgs.some((i) => (i.spec as { generating?: boolean }).generating) ? 4000 : false;
      },
    },
  );
  const settings = trpc.settings.get.useQuery();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [qc, setQc] = useState<QcItem[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [saved, setSaved] = useState(false);

  // 只在「打开另一篇笔记」时用服务端数据初始化本地编辑状态。
  // 不能用 [note.data] 依赖：后台轮询/任何配图操作触发的刷新都会返回新对象，
  // 把用户未保存的正文修改（含 AI 改写结果）重置回旧版本。
  const loadedNoteId = useRef<number | null>(null);
  useEffect(() => {
    if (note.data && loadedNoteId.current !== note.data.id) {
      loadedNoteId.current = note.data.id;
      setTitle(note.data.title);
      setBody(note.data.body);
      setTags(note.data.tags);
      setQc(note.data.qcReport as QcItem[]);
    }
  }, [note.data]);

  // 登记脏标记：标题/正文/标签与服务端不一致时，关闭页面前 beforeunload 拦截
  useEffect(() => {
    const dirty = note.data ? title !== note.data.title || body !== note.data.body || JSON.stringify(tags) !== JSON.stringify(note.data.tags) : false;
    __dirtySet("note:" + noteId, dirty);
    return () => __dirtySet("note:" + noteId, false);
  }, [title, body, tags, note.data, noteId]);

  const [saveError, setSaveError] = useState("");
  const update = trpc.notes.update.useMutation({
    onSuccess: (r) => {
      setQc(r.qc as QcItem[]);
      setSaved(true);
      setSaveError("");
      setTimeout(() => setSaved(false), 2000);
      utils.notes.list.invalidate();
    },
    onError: (e) => setSaveError(friendlyApiError(e.message)),
  });
  const refreshTitles = trpc.notes.refreshTitles.useMutation({
    onSuccess: () => note.refetch(),
  });
  const setStatus = trpc.notes.setStatus.useMutation({
    onSuccess: () => {
      note.refetch();
      utils.notes.list.invalidate();
    },
    onError: (e) => setSaveError(friendlyApiError(e.message)),
  });
  const remove = trpc.notes.remove.useMutation({
    onSuccess: () => navigate("/notes"),
    onError: (e) => setSaveError(friendlyApiError(e.message)),
  });

  // AI 修改正文
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [rewriteApplied, setRewriteApplied] = useState(false);
  const rewrite = trpc.notes.rewriteBody.useMutation({
    onSuccess: (r) => {
      setBody(r.body);
      setRewriteInstruction("");
      setRewriteApplied(true);
      setTimeout(() => setRewriteApplied(false), 4000);
    },
  });

  // 添加配图
  const [addKind, setAddKind] = useState<ImageKind | null>(null);
  const [addPrompt, setAddPrompt] = useState("");
  const addImage = trpc.notes.addImage.useMutation({
    onSuccess: () => {
      setAddKind(null);
      setAddPrompt("");
      note.refetch();
    },
  });

  // AI 文生图
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiMode, setAiMode] = useState<AiMode>("illustration");
  const [pickedPlan, setPickedPlan] = useState(-1);

  // 画面方案缓存：按 笔记ID+模式 存 localStorage，切换步骤/刷新页面都不丢；
  // 只有点「重新生成」才会覆盖
  const plansCacheKey = (mode: AiMode) => `aiPlans:${noteId}:${mode}`;
  const readPlansCache = (mode: AiMode): ImagePlan[] => {
    try {
      const raw = localStorage.getItem(plansCacheKey(mode));
      const arr = raw ? (JSON.parse(raw) as ImagePlan[]) : [];
      return Array.isArray(arr) ? arr.filter((p) => p && typeof p.prompt === "string") : [];
    } catch {
      return [];
    }
  };
  const [aiPlans, setAiPlans] = useState<ImagePlan[]>(() => readPlansCache("illustration"));

  const addAiImage = trpc.notes.addAiImage.useMutation({
    onSuccess: () => {
      setAiOpen(false);
      setAiPrompt("");
      setPickedPlan(-1);
      note.refetch();
    },
  });
  const imagePlans = trpc.notes.imagePlans.useMutation({
    onSuccess: (r) => {
      setAiPlans(r.plans);
      setPickedPlan(-1);
      try {
        localStorage.setItem(plansCacheKey(aiMode), JSON.stringify(r.plans));
      } catch {
        /* 缓存失败不影响使用 */
      }
    },
  });

  // 微调画面描述：一句话修改意见 → LLM 修订当前描述并回填到输入框
  const [refineText, setRefineText] = useState("");
  const refinePrompt = trpc.notes.refineImagePrompt.useMutation({
    onSuccess: (r) => {
      setAiPrompt(r.prompt);
      setRefineText("");
    },
  });

  // 笔记级风格统一：AI 画风 + 模板图配色
  const [themeMsg, setThemeMsg] = useState("");
  const setNoteStyle = trpc.notes.setNoteStyle.useMutation({
    onSuccess: () => note.refetch(),
  });
  const setNoteTheme = trpc.notes.setNoteTheme.useMutation({
    onSuccess: (r) => {
      setThemeMsg(r.updated > 0 ? `已统一 ${r.updated} 张模板图配色` : "已设为默认配色");
      setTimeout(() => setThemeMsg(""), 3000);
      note.refetch();
    },
  });

  // 切换模式时载入该模式的缓存方案
  const switchAiMode = (mode: AiMode) => {
    setAiMode(mode);
    setAiPlans(readPlansCache(mode));
    setPickedPlan(-1);
  };

  // 渲染全部配图为 PNG dataURL：模板图直接渲染；流程图先异步渲染 mermaid 再导出
  const renderAllPngs = async (format: "png" | "jpeg" = "png"): Promise<{ name: string; dataUrl: string }[] & { skipped: number }> => {
    // 过滤生成中/失败的 AI 占位图，避免空白卡被下载或同步发布
    const images = (note.data?.images ?? []).filter((i) => {
      const sp = i.spec as { generating?: boolean; error?: string };
      return !sp.generating && !sp.error;
    });
    let mermaidMod: typeof import("mermaid") | null = null;
    const out = [] as unknown as { name: string; dataUrl: string }[] & { skipped: number };
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      let svg: string;
      if (img.kind === "diagram") {
        if (!mermaidMod) {
          mermaidMod = await import("mermaid");
          mermaidMod.default.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            htmlLabels: false,
          });
        }
        try {
          const rendered = await mermaidMod.default.render(`mmd-dl-${img.id}`, (img.spec as DiagramSpec).mermaid);
          svg = renderDiagramCardSvg(rendered.svg, img.spec as DiagramSpec);
        } catch {
          svg = renderImageSvg(img.spec); // mermaid 语法有误时用占位卡兜底
        }
      } else {
        svg = renderImageSvg(img.spec);
      }
      const label =
        img.kind === "photo"
          ? ((img.spec as { source?: string }).source === "ai" ? "AI生图" : "素材图")
          : (IMAGE_KIND_META.find((m) => m.kind === img.kind)?.label ?? img.kind);
      const ext = format === "jpeg" ? ".jpg" : ".png";
      out.push({ name: `${String(i + 1).padStart(2, "0")}-${label}${ext}`, dataUrl: await svgToPngDataUrl(svg, format) });
    }
    // 记录被跳过的生成中/失败图数量，供调用方提示
    return ((out.skipped = (note.data?.images ?? []).length - images.length), out);
  };

  // 一键下载全部配图（防连点；跳过生成中/失败的图并提示数量；失败提示重试）
  const [downloadingAll, setDownloadingAll] = useState(false);
  const downloadAllImages = async () => {
    if (!((note.data?.images ?? []).length === 0 || downloadingAll)) {
      setDownloadingAll(true), setSaveError("");
      try {
        const pngs = await renderAllPngs();
        if (pngs.length === 0) {
          setSaveError("没有可下载的图片（生成中/失败的图已跳过）"), setTimeout(() => setSaveError(""), 5e3);
          return;
        }
        await downloadZip(
          pngs.map((f) => ({ name: f.name, data: dataUrlToBytes(f.dataUrl) })),
          (note.data?.title || "笔记图片") + ".zip",
        ), pngs.skipped > 0 && (setSaveError(`已跳过 ${pngs.skipped} 张生成中/失败的图`), setTimeout(() => setSaveError(""), 6e3));
      } catch {
        setSaveError("打包下载失败，请重试"), setTimeout(() => setSaveError(""), 5e3);
      } finally {
        setDownloadingAll(false);
      }
    }
  };

  // 同步到小红书草稿箱：渲染全部 PNG → 随标题/正文/标签入库 → 服务器上的同步服务拉取并存草稿
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [showToken, setShowToken] = useState(false);
  const syncTokenQuery = trpc.notes.getSyncToken.useQuery(undefined, { enabled: showToken });
  const requestSync = trpc.notes.requestSync.useMutation();
  const syncUploadImage = trpc.notes.syncUploadImage.useMutation();
  const syncToDrafts = async () => {
    const n0 = note.data;
    if (!n0 || n0.images.length === 0 || syncing) return;
    setSyncing(true);
    try {
      setSyncMsg("正在渲染配图…");
      const pngs = await renderAllPngs("jpeg"); // 同步用 JPEG：体积约为 PNG 的 1/10，避免超时
      if (pngs.length > 18) {
        setSyncMsg(`配图共 ${pngs.length} 张，超过小红书单次 18 张上限，请删掉 ${pngs.length - 18} 张后再同步`);
        setTimeout(() => setSyncMsg(""), 8000);
        return;
      }
      if (pngs.length === 0) {
        setSyncMsg("没有可同步的配图（生成中/失败的图不会同步）");
        setTimeout(() => setSyncMsg(""), 5000);
        return;
      }
      // 先提交元数据，再逐张上传图片：避免单请求过大触发平台 60 秒限制
      await requestSync.mutateAsync({
        id: noteId,
        title: title.trim() || n0.title,
        body,
        tags,
        imageNames: pngs.map((p) => p.name),
      });
      for (let i = 0; i < pngs.length; i++) {
        setSyncMsg(`正在上传图片 ${i + 1}/${pngs.length}…`);
        await syncUploadImage.mutateAsync({ id: noteId, index: i, name: pngs[i].name, dataUrl: pngs[i].dataUrl });
      }
      setSyncMsg("已加入同步队列，到服务器状态页预览后点「发布」");
      setTimeout(() => setSyncMsg(""), 5000);
      utils.notes.get.invalidate();
    } catch (e) {
      setSyncMsg(`同步失败：${friendlyApiError(e instanceof Error ? e.message : String(e))}`);
      setTimeout(() => setSyncMsg(""), 8000);
    } finally {
      setSyncing(false);
    }
  };

  if (note.isLoading) {
    return <div className="flex justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-stone-400" /></div>;
  }
  if (!note.data) {
    return <div className="py-24 text-center text-stone-500">笔记不存在</div>;
  }

  const n = note.data;
  const failCount = qc.filter((q) => q.level === "fail").length;
  // 代码卡单独归为「合集」，其余配图走普通网格
  const codeImages = n.images.filter((i) => i.kind === "code");
  const problemImages = n.images.filter((i) => i.kind === "problem");
  const otherImages = n.images.filter((i) => i.kind !== "code" && i.kind !== "problem");
  const exportText = `${title}\n\n${body}\n\n${tags.map((t) => `#${t}`).join(" ")}`;

  // 复制到剪贴板：http 自托管站点 navigator.clipboard 不可用（仅安全上下文），需 execCommand 兜底
  const handleCopy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(exportText);
      } else {
        const ta = document.createElement("textarea");
        ta.value = exportText;
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("copy failed");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyError(true);
      setTimeout(() => setCopyError(false), 2500);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {/* 复制结果悬浮提示 */}
      {(copied || copyError) && (
        <div
          className={`fixed left-1/2 top-6 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm shadow-lg transition-all ${
            copied ? "bg-stone-900 text-white" : "bg-red-600 text-white"
          }`}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-400" /> : null}
          {copied ? "复制成功" : "复制失败，请手动选择文本复制"}
        </div>
      )}
      {/* 顶栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-stone-900">笔记编辑器</h1>
          {n.isDemo && (
            <Badge variant="outline" className="border-amber-300 text-amber-600">
              <FlaskConical className="mr-1 h-3 w-3" /> 演示模式内容
            </Badge>
          )}
          <Badge className={n.status === "published" ? "bg-green-100 text-green-700 hover:bg-green-100" : "bg-stone-100 text-stone-600 hover:bg-stone-100"}>
            {n.status === "published" ? "已发布" : "草稿"}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCopy()}
          >
            {copied ? <Check className="mr-1.5 h-4 w-4 text-green-600" /> : <ClipboardCopy className="mr-1.5 h-4 w-4" />}
            {copied ? "已复制" : "复制文案"}
          </Button>
          <Button
            size="sm"
            className="bg-orange-600 hover:bg-orange-700"
            disabled={update.isPending || !title.trim() || !body.trim()}
            title={!title.trim() || !body.trim() ? "标题和正文不能为空" : undefined}
            onClick={() => update.mutate({ id: noteId, title, body, tags })}
          >
            {update.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : saved ? <Check className="mr-1.5 h-4 w-4" /> : null}
            {saved ? "已保存" : "保存修改"}
            {n && (title !== n.title || body !== n.body || JSON.stringify(tags) !== JSON.stringify(n.tags)) && (
              <span className="ml-1.5 text-xs text-amber-500">未保存 ●</span>
            )}
          </Button>
          {saveError && <span className="self-center text-xs text-red-600">{saveError}</span>}
          <Button
            size="sm"
            variant={n.status === "published" ? "outline" : "secondary"}
            onClick={() => setStatus.mutate({ id: noteId, status: n.status === "published" ? "draft" : "published" })}
          >
            {n.status === "published" ? "取消发布标记" : "标记已发布"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-stone-400 hover:text-red-600"
            onClick={() => {
              if (confirm("确定删除这篇笔记及其配图？")) remove.mutate({ id: noteId });
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* 左：文案编辑 */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center justify-between text-sm">
                <span>标题（{[...title].length}/20 字）</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={refreshTitles.isPending || !(settings.data?.llmConfigured ?? false)}
                  title={settings.data?.llmConfigured ? "" : "配置 LLM Key 后可用"}
                  onClick={() => refreshTitles.mutate({ id: noteId })}
                >
                  {refreshTitles.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
                  换一批
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <input
                className={`w-full rounded-lg border px-3 py-2 text-base font-medium outline-none focus:border-orange-400 ${
                  [...title].length > 20 ? "border-red-300 bg-red-50" : "border-stone-200"
                }`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <div className="flex flex-wrap gap-1.5">
                {n.titleCandidates.map((t, i) => (
                  <button
                    key={i}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      t === title
                        ? "border-orange-500 bg-orange-50 text-orange-700"
                        : "border-stone-200 text-stone-600 hover:border-orange-300"
                    }`}
                    onClick={() => setTitle(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">正文</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                className="min-h-[420px] font-mono text-sm leading-6"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              {/* AI 修改正文 */}
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-stone-600">
                  <Wand2 className="h-3.5 w-3.5 text-orange-500" />
                  AI 修改正文
                  {!settings.data?.llmConfigured && <span className="text-stone-400">（需先在设置页配置 LLM Key）</span>}
                </div>
                <div className="flex gap-2">
                  <input
                    className="flex-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-orange-400"
                    placeholder="如：整体缩短一半；把代码换成 Java；语气再活泼一点"
                    value={rewriteInstruction}
                    onChange={(e) => setRewriteInstruction(e.target.value)}
                    disabled={!settings.data?.llmConfigured || rewrite.isPending}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && rewriteInstruction.trim()) {
                        rewrite.mutate({ id: noteId, instruction: rewriteInstruction.trim(), currentBody: body });
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    className="shrink-0 bg-orange-600 hover:bg-orange-700"
                    disabled={!settings.data?.llmConfigured || !rewriteInstruction.trim() || rewrite.isPending}
                    onClick={() => rewrite.mutate({ id: noteId, instruction: rewriteInstruction.trim(), currentBody: body })}
                  >
                    {rewrite.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1.5 h-4 w-4" />}
                    改写
                  </Button>
                </div>
                {rewriteApplied && (
                  <div className="mt-2 text-xs text-green-600">改写结果已填入上方编辑器，检查满意后点右上角「保存修改」</div>
                )}
                {rewrite.isError && (
                  <div className="mt-2 text-xs text-red-600">{friendlyApiError(rewrite.error.message)}</div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">标签（{tags.length} 个）</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <span key={t} className="flex items-center gap-1 rounded-full bg-orange-50 px-2.5 py-1 text-xs text-orange-700">
                    #{t}
                    <button onClick={() => setTags(tags.filter((x) => x !== t))}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                className="w-full rounded-lg border border-stone-200 px-3 py-1.5 text-sm outline-none focus:border-orange-400"
                placeholder="输入标签后回车添加"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagInput.trim()) {
                    if (!tags.includes(tagInput.trim()) && tags.length < 15) {
                      setTags([...tags, tagInput.trim()]);
                    }
                    setTagInput("");
                  }
                }}
              />
            </CardContent>
          </Card>
        </div>

        {/* 右：质检 */}
        <div className="space-y-4">
          <Card className={failCount > 0 ? "border-red-200" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">质检报告</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {qc.map((q, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  {q.level === "pass" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />}
                  {q.level === "warn" && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />}
                  {q.level === "fail" && <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
                  <div>
                    <span className="font-medium text-stone-700">{q.item}</span>
                    <span className="ml-1.5 text-stone-500">{q.message}</span>
                  </div>
                </div>
              ))}
              {qc.length === 0 && <div className="text-xs text-stone-400">保存后自动质检</div>}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* 配图工作台（全宽）：模板配图 / AI 生图 / 素材原图统一在这里管理 */}
      <div className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-base font-semibold text-stone-800">配图工作台</span>
                <span className="text-xs text-stone-400">共 {n.images.length} 张</span>
              </div>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={n.images.length === 0 || downloadingAll}
                  title="按当前顺序下载全部配图为 PNG"
                  onClick={() => void downloadAllImages()}
                >
                  {downloadingAll ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="mr-1 h-3.5 w-3.5" />
                  )}
                  {downloadingAll ? "下载中…" : "全部下载"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50"
                  disabled={n.images.length === 0 || syncing}
                  title="渲染全部配图并加入同步队列，到服务器状态页预览后手动发布"
                  onClick={() => void syncToDrafts()}
                >
                  {syncing ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="mr-1 h-3.5 w-3.5" />
                  )}
                  {syncing ? "上传中…" : "同步到草稿箱"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1.5 text-xs text-stone-400"
                  title="查看同步服务配置所需的令牌"
                  onClick={() => setShowToken((v) => !v)}
                >
                  <KeyRound className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setAiOpen(false);
                    setAddKind(addKind ? null : ("quote" as ImageKind));
                  }}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> 添加配图
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  title="用文生图 API 生成封面氛围图/插图"
                  onClick={() => {
                    setAddKind(null);
                    setAiOpen(!aiOpen);
                  }}
                >
                  <Sparkles className="mr-1 h-3.5 w-3.5" /> AI 生图
                </Button>
              </div>
            </div>

            {(n.syncStatus !== "none" || syncMsg || showToken) && (
              <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs space-y-1.5">
                {n.syncStatus !== "none" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-stone-500">草稿箱同步：</span>
                    {n.syncStatus === "pending" && <Badge variant="outline" className="text-amber-600 border-amber-300">待同步（等待服务器拉取）</Badge>}
                    {n.syncStatus === "syncing" && <Badge variant="outline" className="text-blue-600 border-blue-300">同步中…</Badge>}
                    {n.syncStatus === "queued" && (
                      <Badge variant="outline" className="text-green-600 border-green-300">
                        已到服务器待发布队列，去状态页检查并发布
                      </Badge>
                    )}
                    {n.syncStatus === "published" && (
                      <Badge variant="outline" className="text-green-600 border-green-300">
                        已发布{n.syncedAt ? `（${new Date(n.syncedAt).toLocaleString("zh-CN")}）` : ""}
                      </Badge>
                    )}
                    {n.syncStatus === "ignored" && <Badge variant="outline" className="text-stone-500 border-stone-300">已在状态页忽略</Badge>}
                    {n.syncStatus === "failed" && <Badge variant="outline" className="text-red-600 border-red-300">失败：{n.syncError ?? "未知错误"}</Badge>}
                    {["queued", "published", "ignored", "failed"].includes(n.syncStatus) && (
                      <span className="text-stone-400">内容有更新？重新点「同步到草稿箱」即可再次入队</span>
                    )}
                  </div>
                )}
                {syncMsg && <div className="text-stone-500">{syncMsg}</div>}
                {showToken && (
                  <div className="flex items-center gap-2">
                    <span className="text-stone-500">同步令牌：</span>
                    <code className="flex-1 truncate rounded bg-white px-2 py-0.5 border border-stone-200 text-stone-700">
                      {syncTokenQuery.data?.token ?? "加载中…"}
                    </code>
                    {syncTokenQuery.data?.token && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5"
                        onClick={() => {
                          const token = syncTokenQuery.data!.token;
                          // http 自托管站点 navigator.clipboard 不可用（仅安全上下文），需 execCommand 兜底
                          if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(token);
                          else {
                            const ta = document.createElement("textarea");
                            (ta.value = token), (ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none"), document.body.appendChild(ta), ta.focus(), ta.select(), document.execCommand("copy"), document.body.removeChild(ta);
                          }
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 风格统一：AI 画风（本篇所有 AI 生图）+ 模板图配色（一键统一） */}
            <div className="grid gap-3 rounded-xl border border-stone-200 bg-white p-3.5 lg:grid-cols-2">
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-stone-600">
                  <Palette className="h-3.5 w-3.5 text-violet-500" />
                  AI 画风 <span className="font-normal text-stone-400">本篇笔记所有 AI 生图统一用这个风格</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {AI_STYLES.map((st) => (
                    <button
                      key={st.id}
                      title={st.desc}
                      disabled={setNoteStyle.isPending}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                        (n.aiStyle ?? "flat") === st.id
                          ? "border-violet-500 bg-violet-50 font-medium text-violet-700"
                          : "border-stone-200 text-stone-600 hover:border-violet-300"
                      }`}
                      onClick={() => setNoteStyle.mutate({ noteId, aiStyle: st.id })}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-stone-600">
                  <Palette className="h-3.5 w-3.5 text-orange-500" />
                  模板图配色 <span className="font-normal text-stone-400">点色块：设为默认并统一全部模板图</span>
                  {themeMsg && <span className="font-normal text-green-600">{themeMsg}</span>}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(THEMES) as ThemeName[]).map((name) => (
                    <button
                      key={name}
                      title={name}
                      disabled={setNoteTheme.isPending}
                      className={`h-7 w-7 rounded-full border-2 transition-all ${
                        n.svgTheme === name ? "scale-110 border-stone-800" : "border-stone-200"
                      }`}
                      style={{ background: `linear-gradient(135deg, ${THEMES[name].bg1}, ${THEMES[name].accent})` }}
                      onClick={() => setNoteTheme.mutate({ noteId, theme: name })}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* AI 文生图面板 */}
            {aiOpen && (
              <div className="rounded-xl border border-violet-200 bg-violet-50/50 p-4">
                <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-violet-700">
                  AI 文生图 <span className="font-normal text-violet-400">竖版 3:4；信息图模式会把笔记里的文字直接画进图里</span>
                  <span className="rounded-full bg-violet-100 px-2 py-0.5 font-normal text-violet-600">
                    当前画风：{AI_STYLES.find((st) => st.id === (n.aiStyle ?? "flat"))?.label ?? "扁平插画"}
                  </span>
                </div>
                {settings.data?.imgConfigured ? (
                  <div className="grid gap-4 lg:grid-cols-[190px_1fr]">
                  {/* 左栏：第 1 步 选图片类型 */}
                  <div>
                    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-stone-600">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-[10px] font-bold text-white">1</span>
                      选图片类型
                    </div>
                    <div className="grid grid-cols-1 gap-1.5">
                      {([
                        { mode: "illustration" as AiMode, label: "氛围插画", desc: "无文字装饰图，配合模板图使用" },
                        { mode: "infographic" as AiMode, label: "内容信息图", desc: "把笔记要点直接画进图里" },
                      ]).map((m) => (
                        <button
                          key={m.mode}
                          className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                            aiMode === m.mode
                              ? "border-violet-500 bg-white shadow-sm"
                              : "border-stone-200 bg-white hover:border-violet-300"
                          }`}
                          onClick={() => switchAiMode(m.mode)}
                        >
                          <div className="text-xs font-medium text-stone-700">{m.label}</div>
                          <div className="mt-0.5 text-[10px] leading-4 text-stone-400">{m.desc}</div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 rounded-lg bg-white/70 px-2.5 py-2 text-[10px] leading-4 text-stone-400">
                      不知道画什么？点右边「AI 出方案」，AI 读完素材会给你 3 个画面创意，点一个自动填入描述
                    </div>
                  </div>
                  {/* 右栏：第 2 步 画面描述 → 第 3 步 生成 */}
                  <div>
                    <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 text-xs font-medium text-stone-600">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-[10px] font-bold text-white">2</span>
                      画面描述
                      <span className="font-normal text-stone-400">可直接手写，或先让 AI 出方案</span>
                    </div>
                    {/* AI 读素材出方案 */}
                    <Button
                      size="sm"
                      variant="outline"
                      className="mb-2 border-violet-300 text-violet-700 hover:bg-violet-100/60"
                      disabled={imagePlans.isPending || !(settings.data?.llmConfigured ?? false)}
                      title={settings.data?.llmConfigured ? "AI 通读原始素材，产出 3 个画面创意" : "需先在设置页配置 LLM Key"}
                      onClick={() => imagePlans.mutate({ noteId, mode: aiMode })}
                    >
                      {imagePlans.isPending ? (
                        <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      ) : (
                        <Lightbulb className="mr-1.5 h-4 w-4" />
                      )}
                      {aiPlans.length > 0 ? "重新生成 3 个画面方案" : "AI 出方案：读素材给我 3 个画面创意"}
                    </Button>
                    {imagePlans.isError && (
                      <div className="mb-2 text-xs text-red-600">{friendlyApiError(imagePlans.error.message)}</div>
                    )}
                    {aiPlans.length > 0 && (
                      <div className="mb-2">
                        <div className="grid gap-1.5 sm:grid-cols-3">
                        {aiPlans.map((p, i) => (
                          <button
                            key={i}
                            className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                              pickedPlan === i
                                ? "border-violet-500 bg-white shadow-sm"
                                : "border-stone-200 bg-white hover:border-violet-300"
                            }`}
                            onClick={() => {
                              setPickedPlan(i);
                              setAiPrompt(p.prompt);
                            }}
                          >
                            <div className="text-xs font-medium text-stone-700">
                              {i + 1}. {p.name}
                            </div>
                            <div className="mt-0.5 text-[10px] leading-4 text-stone-400">{p.desc}</div>
                          </button>
                        ))}
                        </div>
                        <div className="mt-1.5 text-[10px] leading-4 text-stone-400">
                          点选方案后描述自动填入下方，可继续修改；方案已缓存在本机，切换步骤/刷新页面不丢失
                        </div>
                      </div>
                    )}
                    <textarea
                      className="min-h-24 w-full rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-violet-400"
                      placeholder={
                        aiMode === "infographic"
                          ? "描述信息图内容，如：标题「动态规划解题五步法」，列出读题、定义状态、转移方程、初始化、返回结果五个步骤"
                          : "描述画面，如：一个戴眼镜的卡通程序员坐在书桌前刷题，桌上放着咖啡和算法书，暖色调"
                      }
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      maxLength={500}
                      disabled={addAiImage.isPending}
                    />
                    {/* 微调：一句话修改意见 → LLM 修订描述并回填 */}
                    <div className="mt-1.5 flex flex-col gap-1.5 sm:flex-row">
                      <input
                        className="min-w-0 flex-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-violet-400"
                        placeholder="对描述不满意？写一句修改意见，如：改成夜晚书房、加一只猫"
                        value={refineText}
                        onChange={(e) => setRefineText(e.target.value)}
                        maxLength={300}
                        disabled={refinePrompt.isPending || addAiImage.isPending}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && refineText.trim().length >= 2 && aiPrompt.trim().length >= 2 && !refinePrompt.isPending) {
                            refinePrompt.mutate({ prompt: aiPrompt.trim(), instruction: refineText.trim(), mode: aiMode });
                          }
                        }}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 border-violet-300 text-violet-700 hover:bg-violet-100/60"
                        disabled={
                          refinePrompt.isPending ||
                          refineText.trim().length < 2 ||
                          aiPrompt.trim().length < 2 ||
                          !(settings.data?.llmConfigured ?? false)
                        }
                        title={settings.data?.llmConfigured ? "AI 按修改意见改写上方描述并回填" : "需先在设置页配置 LLM Key"}
                        onClick={() => refinePrompt.mutate({ prompt: aiPrompt.trim(), instruction: refineText.trim(), mode: aiMode })}
                      >
                        {refinePrompt.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1.5 h-4 w-4" />}
                        AI 微调描述
                      </Button>
                    </div>
                    {refinePrompt.isError && (
                      <div className="mt-1 text-xs text-red-600">{friendlyApiError(refinePrompt.error.message)}</div>
                    )}
                    <div className="mb-1.5 mt-3 flex items-center gap-1.5 text-xs font-medium text-stone-600">
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-600 text-[10px] font-bold text-white">3</span>
                      生成图片
                    </div>
                    <Button
                      size="sm"
                      className="w-full bg-violet-600 hover:bg-violet-700"
                      disabled={addAiImage.isPending || aiPrompt.trim().length < 2}
                      onClick={() => addAiImage.mutate({ noteId, prompt: aiPrompt.trim(), mode: aiMode })}
                    >
                      {addAiImage.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                      生成图片（约 30-60 秒，可继续编辑其他内容，完成后自动出现）
                    </Button>
                  </div>
                  </div>
                ) : (
                  <div className="rounded-lg bg-white/70 px-3 py-2 text-xs text-stone-500">
                    还未配置文生图 API。请到「设置」页填写图片接口信息（支持火山引擎即梦、智谱 CogView 等）。
                  </div>
                )}
                {addAiImage.isError && <div className="mt-2 text-xs text-red-600">{friendlyApiError(addAiImage.error.message)}</div>}
              </div>
            )}

            {/* 配图类型选择器 */}
            {addKind && (
              <div className="rounded-xl border border-orange-200 bg-orange-50/50 p-4">
                <div className="mb-2 text-xs font-medium text-stone-600">选择要生成的配图类型</div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {IMAGE_KIND_META.map((m) => (
                    <button
                      key={m.kind}
                      className={`rounded-lg border px-2.5 py-2 text-left transition-colors ${
                        addKind === m.kind ? "border-orange-500 bg-white shadow-sm" : "border-stone-200 bg-white hover:border-orange-300"
                      }`}
                      onClick={() => setAddKind(m.kind)}
                    >
                      <div className="text-xs font-medium text-stone-700">{m.label}</div>
                      <div className="mt-0.5 text-[10px] leading-4 text-stone-400">{m.desc}</div>
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    className="flex-1 rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-orange-400"
                    placeholder="对这张图的要求（可选），如：突出空间换时间的思路"
                    value={addPrompt}
                    onChange={(e) => setAddPrompt(e.target.value)}
                    disabled={addImage.isPending}
                  />
                  <Button
                    size="sm"
                    className="shrink-0 bg-orange-600 hover:bg-orange-700"
                    disabled={addImage.isPending}
                    onClick={() => addImage.mutate({ noteId, kind: addKind, prompt: addPrompt.trim() || undefined })}
                  >
                    {addImage.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1.5 h-4 w-4" />}
                    生成这张配图
                  </Button>
                </div>
                {addImage.isError && <div className="mt-2 text-xs text-red-600">{friendlyApiError(addImage.error.message)}</div>}
              </div>
            )}

            {/* 代码卡合集：所有代码页整体展示、整体微调 */}
            {codeImages.length > 0 && (
              <CodeImageGroup
                noteId={noteId}
                images={codeImages}
                llmReady={settings.data?.llmConfigured ?? false}
              />
            )}

            {/* 题目描述图合集：所有题目描述页整体展示、整体微调 */}
            {problemImages.length > 0 && (
              <ProblemImageGroup
                noteId={noteId}
                images={problemImages}
                llmReady={settings.data?.llmConfigured ?? false}
              />
            )}

            {otherImages.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {otherImages.map((img) => (
                  <NoteImageCard
                    key={`${img.id}-v${img.version}`}
                    image={img}
                    llmReady={settings.data?.llmConfigured ?? false}
                  />
                ))}
              </div>
            ) : (
              codeImages.length === 0 && problemImages.length === 0 && (
                <div className="rounded-xl border border-dashed border-stone-200 py-12 text-center text-sm text-stone-400">
                  还没有配图，用上方「添加配图」或「AI 生图」创建第一张
                </div>
              )
            )}
          </div>

          {n.materialId != null && <MaterialImagesPanel materialId={n.materialId} noteId={noteId} />}
      </div>
    </div>
  );
}
