import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, Link2, ListTree, Loader2, RefreshCw, Sparkles, Trash2, ClipboardPaste, ImageIcon, Wand2 } from "lucide-react";
import MaterialImagesPanel from "@/components/MaterialImagesPanel";
import { __dirtySet } from "@/components/NoteImageCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { IMAGE_KIND_META, type ImageKind } from "@contracts/types";
import { friendlyApiError } from "@/lib/utils";

type OutlineAngle = { name: string; focus: string; why: string };

const NOTE_TYPE_OPTIONS = [
  { value: "solution", label: "题解笔记（默认）", desc: "痛点→题目→思路→代码→复杂度" },
  { value: "summary", label: "知识点总结", desc: "体系化要点清单，收藏向" },
  { value: "experience", label: "面试经验谈", desc: "第一人称故事 + 心得" },
  { value: "roadmap", label: "学习路线", desc: "分阶段规划 + 避坑" },
];

/** 素材详情弹窗：查看/编辑完整内容、骨架与创作角度；保存走 materials.update + saveOutline */
function NfMatDetail({ id, onClose, utils }: { id: number | null; onClose: () => void; utils: ReturnType<typeof trpc.useUtils> }) {
  const detail = trpc.materials.get.useQuery({ id: id! }, { enabled: id != null });
  const m = detail.data;
  // angles 在库里是 JSON 字符串，编辑时格式化为多行文本
  const fmtAng = (ang: unknown): string => {
    if (ang == null || ang === "") return "";
    try {
      const parsed = typeof ang === "string" ? JSON.parse(ang) : ang;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return typeof ang === "string" ? ang : "";
    }
  };
  const parseAng = (ang: unknown): OutlineAngle[] => {
    try {
      const parsed = typeof ang === "string" ? JSON.parse(ang) : ang;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const t0 = m?.title ?? "";
  const c0 = m?.content ?? "";
  const k0 = m?.skeleton ?? "";
  const a0 = fmtAng(m ? m.angles : null);
  const [titleDraft, setTitleDraft] = useState("");
  const [contentDraft, setContentDraft] = useState("");
  const [skeletonDraft, setSkeletonDraft] = useState("");
  const [anglesDraft, setAnglesDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [initialized, setInitialized] = useState(false);
  const upd = trpc.materials.update.useMutation();
  const so = trpc.materials.saveOutline.useMutation();
  const ex = trpc.materials.extractOutline.useMutation({
    onSuccess: (r) => {
      setSkeletonDraft(r.skeleton ?? ""), setAnglesDraft(fmtAng(r.angles)), setError(""), setNotice("骨架已重新提取"), utils.materials.get.invalidate(), utils.materials.list.invalidate();
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  // 数据到达后初始化草稿一次（之后不被 refetch 覆盖）
  useEffect(() => {
    m && !initialized && (setTitleDraft(t0), setContentDraft(c0), setSkeletonDraft(k0), setAnglesDraft(a0), setInitialized(true));
  }, [m, initialized, t0, c0, k0, a0]);
  const dirty = titleDraft !== t0 || contentDraft !== c0 || skeletonDraft !== k0 || anglesDraft !== a0;
  useEffect(() => (__dirtySet("material:" + id, dirty), () => __dirtySet("material:" + id, false)), [dirty, id]);
  const handleClose = () => {
    (dirty && !confirm("有未保存的修改，确定关闭吗？")) || (__dirtySet("material:" + id, false), onClose());
  };
  const handleSave = async () => {
    setError(""), setNotice("");
    if (!m) return;
    let parsed: OutlineAngle[] | null = null;
    const anglesDirty = anglesDraft !== a0, skeletonDirty = skeletonDraft !== k0;
    if (anglesDirty) {
      const raw = anglesDraft.trim();
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          setError("创作角度 JSON 格式不正确，未保存");
          return;
        }
        if (!Array.isArray(parsed)) {
          setError('创作角度必须是数组，如 [{"name":"角度名","focus":"侧重点","why":"原因"}]');
          return;
        }
        if (parsed.length > 6) {
          setError("创作角度最多 6 个");
          return;
        }
        for (const a of parsed) {
          if (!a || typeof a.name !== "string" || typeof a.focus !== "string") {
            setError("每个角度需包含 name 和 focus 字符串");
            return;
          }
          if (a.name.length > 20) {
            setError("角度 name 最长 20 字");
            return;
          }
          if (a.focus.length > 100) {
            setError("角度 focus 最长 100 字");
            return;
          }
          if ((a.why ?? "").length > 50) {
            setError("角度 why 最长 50 字");
            return;
          }
        }
      } else parsed = [];
    }
    if (skeletonDirty && skeletonDraft.trim().length > 6000) {
      setError("骨架最长 6000 字");
      return;
    }
    const outlineDirty = skeletonDirty || anglesDirty;
    let skeletonToSave: string | null = null;
    if (outlineDirty) {
      if (((skeletonToSave = skeletonDirty ? skeletonDraft.trim() : k0), !skeletonToSave)) {
        setError("骨架为空时无法保存角度，请先填写骨架或点「立即提取」");
        return;
      }
    }
    const patch: { title?: string; content?: string } = {};
    titleDraft !== t0 && (patch.title = titleDraft), contentDraft !== c0 && (patch.content = contentDraft);
    try {
      Object.keys(patch).length && (await upd.mutateAsync({ id: id!, ...patch })),
        outlineDirty && (await so.mutateAsync({ id: id!, skeleton: skeletonToSave!, angles: anglesDirty ? parsed! : parseAng(m.angles) })),
        await Promise.all([utils.materials.list.invalidate(), utils.materials.get.invalidate()]),
        setInitialized(false),
        setNotice(contentDraft !== c0 ? "已保存；正文已修改，骨架将在下次提取时重新生成" : "已保存");
    } catch (e) {
      setError(friendlyApiError(((e as Error) && (e as Error).message) || String(e)));
    }
  };
  return (
    <Dialog open onOpenChange={(open) => { open || handleClose(); }}>
      <DialogContent className="flex max-h-[94vh] w-[96vw] max-w-4xl flex-col overflow-x-hidden overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>素材详情 / 编辑</DialogTitle>
          <DialogDescription>查看并编辑素材内容、骨架与创作角度；保存后可在列表重新生成笔记</DialogDescription>
        </DialogHeader>
        {detail.isPending && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
            加载素材详情…
          </div>
        )}
        {detail.isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            加载失败：{detail.error.message}
            <button className="ml-2 underline" onClick={() => detail.refetch()}>重试</button>
          </div>
        )}
        {m && (
          <div className="flex flex-1 flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-stone-700">标题</label>
              <Input value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} maxLength={200} />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-stone-700">来源信息</label>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                <span className="rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5">{(m as { sourceLabel?: string }).sourceLabel || "未知来源"}</span>
                {m.sourceUrl ? (
                  <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="max-w-[420px] truncate text-orange-600 underline">
                    {m.sourceUrl}
                  </a>
                ) : (
                  <span className="text-stone-400">粘贴文本导入，无链接</span>
                )}
                <span className="text-stone-400">创建：{new Date(m.createdAt).toLocaleString("zh-CN")}</span>
              </div>
            </div>
            <div>
              <label className="mb-1.5 flex items-baseline gap-2 text-sm font-medium text-stone-700">
                正文内容
                <span className="text-xs font-normal text-stone-400">{(contentDraft ?? "").length} 字</span>
              </label>
              <Textarea value={contentDraft} onChange={(e) => setContentDraft(e.target.value)} rows={14} className="min-h-[260px] resize-y text-sm leading-6" />
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <label className="text-sm font-medium text-stone-700">骨架</label>
                <span className="text-xs text-stone-400">AI 从素材提炼的大纲，可直接改</span>
                {!k0 && <span className="text-xs text-amber-500">尚未提取骨架，保存正文后可在生成笔记时提取</span>}
              </div>
              <Textarea
                value={skeletonDraft}
                onChange={(e) => setSkeletonDraft(e.target.value)}
                maxLength={6000}
                className="min-h-[160px] resize-y font-mono text-xs leading-5"
                placeholder="骨架为空时可手写，或点击下方按钮由 AI 提取"
              />
              <div className="mt-1.5 flex gap-2">
                {!k0 && (
                  <Button size="sm" variant="outline" disabled={ex.isPending} onClick={() => ex.mutate({ id: id! })}>
                    {ex.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                    立即提取
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-stone-400"
                  disabled={ex.isPending}
                  onClick={() => {
                    confirm("重新提取会覆盖当前骨架和角度，确定吗？") && ex.mutate({ id: id!, force: true });
                  }}
                >
                  {ex.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                  AI 重新提取
                </Button>
              </div>
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
                <label className="text-sm font-medium text-stone-700">创作角度</label>
                <span className="text-xs text-stone-400">{'JSON 数组，如 [{"name":"角度名","focus":"侧重点","why":"原因"}]，最多 6 个'}</span>
                {m.angles == null && <span className="text-xs text-amber-500">尚未生成角度</span>}
              </div>
              <Textarea
                value={anglesDraft}
                onChange={(e) => setAnglesDraft(e.target.value)}
                className="min-h-[120px] resize-y font-mono text-xs leading-5"
                placeholder='[{"name":"...","focus":"...","why":"..."}]'
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-stone-700">图片</label>
              <MaterialImagesPanel materialId={id!} />
            </div>
          </div>
        )}
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {notice && <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
        <DialogFooter>
          {dirty && <span className="mr-auto text-xs text-amber-500">未保存 ●</span>}
          <Button variant="outline" onClick={handleClose}>取消</Button>
          <Button
            className="bg-orange-600 hover:bg-orange-700"
            disabled={!dirty || upd.isPending || so.isPending || ex.isPending}
            onClick={handleSave}
          >
            {(upd.isPending || so.isPending) && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Materials() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const list = trpc.materials.list.useQuery();

  const [url, setUrl] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteContent, setPasteContent] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 生成设置对话框
  const [genTarget, setGenTarget] = useState<number | null>(null);
  const [noteType, setNoteType] = useState("solution");
  const [instruction, setInstruction] = useState("");
  const [imageKinds, setImageKinds] = useState<ImageKind[]>(["cover", "steps", "code"]);
  // 骨架 + 创作角度
  const [skeletonDraft, setSkeletonDraft] = useState("");
  const [angles, setAngles] = useState<OutlineAngle[]>([]);
  const [pickedAngle, setPickedAngle] = useState(-1); // -1 自由发挥；-2 自定义；>=0 角度下标
  const [customAngle, setCustomAngle] = useState("");
  const [refineInput, setRefineInput] = useState("");
  const [outlineCached, setOutlineCached] = useState(false);
  // 素材详情弹窗：导入成功后自动打开，也可从列表「详情」进入
  const [dtl, setDtl] = useState<number | null>(null);

  const importLink = trpc.materials.importLink.useMutation({
    onSuccess: (r) => {
      setUrl("");
      setError("");
      setNotice(
        [
          `导入成功（${r.sourceLabel}）：正文 ${r.contentLength} 字` + (r.imageCount > 0 ? `，图片 ${r.imageCount} 张` : ""),
          ...(r.warnings ?? []),
        ].join("；"),
      );
      utils.materials.list.invalidate();
      r.id != null && setDtl(r.id);
    },
    onError: (e) => {
      setError(friendlyApiError(e.message));
      setNotice("");
    },
  });
  const importText = trpc.materials.importText.useMutation({
    onSuccess: (r) => {
      setPasteTitle("");
      setPasteContent("");
      setError("");
      utils.materials.list.invalidate();
      r && r.id != null && setDtl(r.id);
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const remove = trpc.materials.remove.useMutation({
    onSuccess: () => utils.materials.list.invalidate(),
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const generate = trpc.notes.generate.useMutation({
    onSuccess: (r) => {
      setGenTarget(null);
      navigate(`/notes/${r.id}`);
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const extractOutline = trpc.materials.extractOutline.useMutation({
    onSuccess: (r) => {
      setSkeletonDraft(r.skeleton);
      setAngles(r.angles);
      setOutlineCached(r.cached);
      setError("");
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const saveOutline = trpc.materials.saveOutline.useMutation();
  const refineOutline = trpc.materials.refineOutline.useMutation({
    onSuccess: (r) => {
      setSkeletonDraft(r.skeleton);
      setRefineInput("");
      setError("");
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });

  const openGenerate = (id: number) => {
    setGenTarget(id);
    setError("");
    setSkeletonDraft("");
    setAngles([]);
    setPickedAngle(-1);
    setCustomAngle("");
    setRefineInput("");
    setOutlineCached(false);
    extractOutline.mutate({ id });
  };

  const startGenerate = async () => {
    if (genTarget == null) return;
    // 先把用户手动改过的骨架/角度存回素材，再生成
    if (skeletonDraft.trim()) {
      try {
        await saveOutline.mutateAsync({ id: genTarget, skeleton: skeletonDraft.trim(), angles });
      } catch { /* 保存失败不阻塞生成 */ }
    }
    const angleText =
      pickedAngle >= 0 && angles[pickedAngle]
        ? `${angles[pickedAngle].name}：${angles[pickedAngle].focus}`
        : pickedAngle === -2 && customAngle.trim()
          ? customAngle.trim()
          : undefined;
    generate.mutate({
      materialId: genTarget,
      noteType,
      instruction: instruction.trim() || undefined,
      imageKinds,
      skeleton: skeletonDraft.trim() || undefined,
      angle: angleText,
    });
  };

  const toggleKind = (kind: ImageKind) => {
    setImageKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
    );
  };

  const busy = importLink.isPending || importText.isPending || generate.isPending || extractOutline.isPending;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900">素材库</h1>
        <p className="mt-1 text-sm text-stone-500">
          支持抖音视频链接、飞书文档、微信公众号文章、小红书笔记，或直接粘贴文本作为生成素材。飞书文档需开启「分享 → 互联网获得链接的人可阅读」；公众号/抖音为公开链接即可；小红书需使用 App 内「分享 → 复制链接」得到的完整分享文本。
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">导入素材</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="link">
            <TabsList>
              <TabsTrigger value="link">
                <Link2 className="mr-1.5 h-3.5 w-3.5" /> 链接导入
              </TabsTrigger>
              <TabsTrigger value="paste">
                <ClipboardPaste className="mr-1.5 h-3.5 w-3.5" /> 粘贴文本
              </TabsTrigger>
            </TabsList>
            <TabsContent value="link" className="space-y-3 pt-3">
              <div className="flex gap-2">
                <Input
                  placeholder="粘贴链接或分享文本：抖音视频 / 飞书文档 / 微信公众号文章 / 小红书笔记"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                />
                <Button
                  onClick={() => {
                    const u = url.trim();
                    if (!u) return;
                    if (!/^https?:\/\/.+\..+/.test(u)) {
                      setError("请输入完整的 http(s) 链接");
                      return;
                    }
                    importLink.mutate({ url: u });
                  }}
                  disabled={busy || !url.trim()}
                  className="shrink-0 bg-orange-600 hover:bg-orange-700"
                >
                  {importLink.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  抓取导入
                </Button>
              </div>
              <p className="text-xs text-stone-400">
                支持飞书 /docx/、/wiki/ 链接和微信公众号文章链接。标题、列表、表格、代码、加粗都会保留，原文中的图片会一并导入，可直接作为笔记配图使用。
              </p>
              <p className="text-xs text-stone-400">
                抖音：提取标题/作者/数据/封面（不含口播文字）；视频号暂无法直接抓取，请用粘贴文本。小红书：使用「分享 → 复制链接」的完整文本，图文笔记会抓取正文、图片，并识别图片中的文字一并导入。
              </p>
            </TabsContent>
            <TabsContent value="paste" className="space-y-3 pt-3">
              <Input
                placeholder="素材标题，如：华为OD 贪心 - 分糖果"
                value={pasteTitle}
                onChange={(e) => setPasteTitle(e.target.value)}
                disabled={busy}
              />
              <Textarea
                placeholder="粘贴飞书文档全文（在飞书里 Ctrl+A 全选复制即可）"
                className="min-h-40 font-mono text-xs"
                value={pasteContent}
                onChange={(e) => setPasteContent(e.target.value)}
                disabled={busy}
              />
              <Button
                onClick={() =>
                  pasteTitle.trim() &&
                  pasteContent.trim().length >= 10 &&
                  importText.mutate({ title: pasteTitle.trim(), content: pasteContent })
                }
                disabled={busy || !pasteTitle.trim() || pasteContent.trim().length < 10}
                className="bg-orange-600 hover:bg-orange-700"
              >
                {importText.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                保存素材
              </Button>
            </TabsContent>
          </Tabs>
          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          {notice && (
            <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {notice}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-3">
        {list.isPending && (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl border border-stone-200 bg-stone-50" />
            ))}
          </div>
        )}
        {list.isError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            加载失败：{list.error.message}
            <button className="ml-2 underline" onClick={() => list.refetch()}>重试</button>
          </div>
        )}
        {list.data?.length === 0 && (
          <div className="rounded-xl border border-dashed border-stone-300 py-12 text-center text-sm text-stone-400">
            还没有素材，先导入一篇飞书文档或公众号文章吧
          </div>
        )}
        {list.data?.map((m) => (
          <Card key={m.id} className="transition-shadow hover:shadow-sm">
            <CardContent className="py-4">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="font-medium text-stone-800">{m.title}</div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-stone-400">
                    <span>{m.sourceLabel}</span>
                    <span>{m.contentLength} 字</span>
                    {m.imageCount > 0 && (
                      <span className="flex items-center gap-0.5 text-orange-500">
                        <ImageIcon className="h-3 w-3" /> {m.imageCount} 张图
                      </span>
                    )}
                    <span>{new Date(m.createdAt).toLocaleDateString("zh-CN")}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  className="bg-orange-600 hover:bg-orange-700"
                  disabled={busy}
                  onClick={() => openGenerate(m.id)}
                >
                  {generate.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-4 w-4" />
                  )}
                  生成笔记
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-stone-600"
                  disabled={busy}
                  onClick={() => setDtl(m.id)}
                >
                  详情
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-stone-400 hover:text-red-600"
                  onClick={() => {
                    if (confirm(`确定删除素材「${m.title}」？`)) remove.mutate({ id: m.id });
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {m.imageCount > 0 && (
                <div className="mt-3">
                  <MaterialImagesPanel materialId={m.id} />
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 生成设置对话框：骨架 → 角度 → 设置 */}
      <Dialog open={genTarget != null} onOpenChange={(open) => !open && setGenTarget(null)}>
        <DialogContent className="flex max-h-[94vh] w-[96vw] max-w-[1500px] flex-col overflow-x-hidden overflow-y-auto sm:max-w-[1500px]">
          <DialogHeader>
            <DialogTitle>生成笔记</DialogTitle>
            <DialogDescription>同一篇素材可以换不同角度生成多篇笔记，互不覆盖</DialogDescription>
          </DialogHeader>

          <div className="grid flex-1 items-stretch gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)_minmax(0,4fr)]">
            {/* 第一步：素材骨架（可编辑 / LLM 微调） */}
            <div className="flex h-full flex-col">
              <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <label className="flex items-center gap-1.5 text-sm font-medium text-stone-700">
                  <ListTree className="h-4 w-4 text-orange-500" />
                  第一步 · 素材骨架
                </label>
                <span className="text-xs text-stone-400">AI 从原素材提炼的大纲，可直接改，正文将围绕它组织</span>
                {outlineCached && (
                  <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                    <Check className="h-3 w-3" /> 已缓存
                  </span>
                )}
              </div>
              {extractOutline.isPending ? (
                <div className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-stone-300 bg-stone-50 px-3 py-6 text-sm text-stone-500">
                  <Loader2 className="h-4 w-4 animate-spin text-orange-500" />
                  AI 正在通读素材、提炼骨架和创作角度…（约 10-30 秒）
                </div>
              ) : (
                <>
                  <Textarea
                    className="min-h-[220px] flex-1 resize-none font-mono text-xs leading-5"
                    placeholder={"素材骨架为空时可手写，如：\n## 题目\n- 华为OD 分糖果（贪心）\n## 思路\n- 排序后双指针…"}
                    value={skeletonDraft}
                    onChange={(e) => setSkeletonDraft(e.target.value)}
                    maxLength={6000}
                  />
                  <div className="mt-1.5 flex gap-2">
                    <Input
                      placeholder="一句话微调骨架，如：突出易错点；把复杂度单独成节"
                      value={refineInput}
                      onChange={(e) => setRefineInput(e.target.value)}
                      disabled={!skeletonDraft.trim() || refineOutline.isPending}
                      className="text-xs"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && refineInput.trim() && genTarget != null) {
                          // 微调基于当前草稿：先存再调，保证 LLM 看到的是最新版
                          const id = genTarget;
                          saveOutline
                            .mutateAsync({ id, skeleton: skeletonDraft.trim(), angles })
                            .then(() => refineOutline.mutateAsync({ id, instruction: refineInput.trim() }))
                            .catch(() => {});
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={!skeletonDraft.trim() || !refineInput.trim() || refineOutline.isPending}
                      onClick={() => {
                        if (genTarget == null) return;
                        const id = genTarget;
                        saveOutline
                          .mutateAsync({ id, skeleton: skeletonDraft.trim(), angles })
                          .then(() => refineOutline.mutateAsync({ id, instruction: refineInput.trim() }))
                          .catch(() => {});
                      }}
                    >
                      {refineOutline.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Wand2 className="mr-1 h-4 w-4" />}
                      微调
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0 text-stone-400"
                      title="重新从素材提取骨架（会覆盖当前编辑）"
                      disabled={extractOutline.isPending}
                      onClick={() => {
                        if (genTarget != null && confirm("重新提取会覆盖当前骨架，确定吗？")) {
                          extractOutline.mutate({ id: genTarget, force: true });
                        }
                      }}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" /> 重新提取
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* 第二步：创作角度 */}
            <div className="flex h-full flex-col">
              <div className="mb-1.5 flex flex-wrap items-baseline gap-x-1.5">
                <label className="text-sm font-medium text-stone-700">第二步 · 创作角度</label>
                <span className="text-xs text-stone-400">选一个侧重点；同一素材可换角度再生成一篇</span>
              </div>
              <div className="grid flex-1 auto-rows-min grid-cols-1 content-start gap-2 sm:grid-cols-2">
                <button
                  className={`rounded-lg border p-2 text-left transition-colors ${
                    pickedAngle === -1 ? "border-orange-400 bg-orange-50" : "border-stone-200 hover:border-stone-300"
                  }`}
                  onClick={() => setPickedAngle(-1)}
                >
                  <span className="block text-sm font-medium text-stone-700">自由发挥</span>
                  <span className="block text-xs text-stone-400">不指定角度，AI 按笔记类型默认套路写</span>
                </button>
                {angles.map((a, i) => (
                  <button
                    key={i}
                    className={`rounded-lg border p-2 text-left transition-colors ${
                      pickedAngle === i ? "border-orange-400 bg-orange-50" : "border-stone-200 hover:border-stone-300"
                    }`}
                    onClick={() => setPickedAngle(i)}
                  >
                    <span className="block text-sm font-medium text-stone-700">{a.name}</span>
                    <span className="block text-xs leading-4 text-stone-500" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{a.focus}</span>
                    {a.why && <span className="mt-0.5 block truncate text-[10px] text-stone-400" title={a.why}>💡 {a.why}</span>}
                  </button>
                ))}
                <button
                  className={`rounded-lg border p-2 text-left transition-colors ${
                    pickedAngle === -2 ? "border-orange-400 bg-orange-50" : "border-stone-200 hover:border-stone-300"
                  }`}
                  onClick={() => setPickedAngle(-2)}
                >
                  <span className="block text-sm font-medium text-stone-700">自定义角度</span>
                  <span className="block text-xs text-stone-400">自己写本篇的侧重点</span>
                </button>
              </div>
              {pickedAngle === -2 && (
                <Input
                  className="mt-2 text-sm"
                  placeholder="如：只讲单调栈这一种解法，和其他解法做对比"
                  value={customAngle}
                  onChange={(e) => setCustomAngle(e.target.value)}
                  maxLength={300}
                />
              )}
            </div>

            {/* 第三栏：第三步设置 + 补充要求 + 配图类型 */}
            <div className="flex h-full flex-col space-y-3">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-stone-700">第三步 · 笔记类型</label>
              <Select value={noteType} onValueChange={setNoteType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NOTE_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label} · {o.desc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-stone-700">
                补充要求 <span className="font-normal text-stone-400">（可选，AI 会优先遵循）</span>
              </label>
              <Textarea
                className="min-h-16 resize-none text-sm"
                placeholder={'如：代码用 Java 写；重点讲清楚为什么用单调栈；标题里带上"华为OD"；正文短一点'}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                maxLength={500}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-stone-700">
                配图类型 <span className="font-normal text-stone-400">（已选 {imageKinds.length} 种）</span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {IMAGE_KIND_META.map((m) => (
                  <label
                    key={m.kind}
                    title={m.desc}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 transition-colors ${
                      imageKinds.includes(m.kind) ? "border-orange-400 bg-orange-50" : "border-stone-200 hover:border-stone-300"
                    }`}
                  >
                    <Checkbox
                      checked={imageKinds.includes(m.kind)}
                      onCheckedChange={() => toggleKind(m.kind)}
                    />
                    <span className="text-xs font-medium text-stone-700">{m.label}</span>
                  </label>
                ))}
              </div>
            </div>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenTarget(null)} disabled={generate.isPending}>
              取消
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700"
              disabled={generate.isPending || extractOutline.isPending || imageKinds.length === 0}
              onClick={() => void startGenerate()}
            >
              {generate.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              开始生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {dtl != null && <NfMatDetail id={dtl} onClose={() => setDtl(null)} utils={utils} />}
    </div>
  );
}
