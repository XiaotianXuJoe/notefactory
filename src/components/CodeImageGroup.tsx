import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { __dirtySet } from "./NoteImageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Download, Layers, Loader2, SlidersHorizontal, Trash2, Wand2 } from "lucide-react";
import { dataUrlToBytes, downloadZip, renderImageSvg, svgToPngDataUrl, THEMES, type ThemeName } from "./imageRender";
import { friendlyApiError } from "@/lib/utils";
import type { CodeSpec } from "@contracts/types";

type CodeImage = {
  id: number;
  kind: string;
  spec: unknown;
  version: number;
  lastPrompt: string | null;
};

/** 代码卡合集：同一笔记的所有代码页整体展示、整体微调。
 *  微调（提示词/参数）都作用在合并后的完整代码上，保存时重新分页。 */
export default function CodeImageGroup({
  noteId,
  images,
  llmReady,
}: {
  noteId: number;
  images: CodeImage[];
  llmReady: boolean;
}) {
  const utils = trpc.useUtils();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 图片列表内容签名：refetch 产生新数组引用但内容不变时，不重置本地草稿
  const imagesSig = images.map((i) => `${i.id}:${JSON.stringify(i.spec)}`).join("|");

  // 合并各分页为完整 spec：去掉「（1/3）」序号和行号偏移
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const merged = useMemo<CodeSpec>(() => {
    const specs = images.map((img) => img.spec as CodeSpec);
    const first = specs[0];
    return {
      kind: "code",
      title: first.title.replace(/（\d+\/\d+）$/, ""),
      lang: first.lang,
      code: specs.map((sp) => sp.code).join("\n"),
      note: first.note,
      theme: first.theme,
    };
  }, [imagesSig]);

  const [draft, setDraft] = useState<CodeSpec>(merged);
  const syncRef = useRef(merged);
  // 仅当合集内容真正变化（AI 微调完成/参数保存）且本地无未保存修改时同步草稿，不打断正在进行的编辑
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cur = JSON.stringify(draft), next = JSON.stringify(merged);
    (cur === next || cur === JSON.stringify(syncRef.current)) && ((syncRef.current = merged), setDraft(merged));
  }, [imagesSig]);
  // 登记脏标记：草稿与合集不一致时，关闭页面前 beforeunload 拦截
  useEffect(() => {
    __dirtySet("codegrp:" + noteId, JSON.stringify(draft) !== JSON.stringify(merged));
    return () => __dirtySet("codegrp:" + noteId, false);
  }, [draft, merged, noteId]);

  const pages = useMemo(
    () => images.map((img) => ({ id: img.id, svg: renderImageSvg(img.spec as CodeSpec) })),
    [images],
  );

  const editGroup = trpc.notes.editCodeGroup.useMutation({
    onSuccess: (r) => {
      setPrompt("");
      setError("");
      setNotice(`已应用修改，合集重新分页为 ${r.pages} 张`);
      setTimeout(() => setNotice(""), 3000);
      utils.notes.get.invalidate();
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const updateGroup = trpc.notes.updateCodeGroup.useMutation({
    onSuccess: (r) => {
      setError("");
      setNotice(`参数已保存，合集共 ${r.pages} 张`);
      setTimeout(() => setNotice(""), 3000);
      utils.notes.get.invalidate();
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const removeImage = trpc.notes.removeImage.useMutation();
  const setPages = trpc.notes.setGroupPageCount.useMutation({
    onSuccess: (r) => {
      setNotice(`已调整为 ${r.pages} 张`);
      utils.notes.get.invalidate();
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });

  // 打包下载防连点：渲染多张 PNG 耗时较长，期间禁用按钮并在失败时提示
  const [zipBusy, setZipBusy] = useState(false);
  const downloadAll = async () => {
    if (zipBusy) return;
    setZipBusy(true), setError("");
    try {
      await downloadZip(
        await Promise.all(
          pages.map(async (p, i) => ({
            name: `${merged.title || "代码卡"}-${i + 1}of${pages.length}.png`,
            data: dataUrlToBytes(await svgToPngDataUrl(p.svg)),
          })),
        ),
        (merged.title || "代码卡") + ".zip",
      );
    } catch {
      setError("打包下载失败，请重试");
    } finally {
      setZipBusy(false);
    }
  };

  const [removingAll, setRemovingAll] = useState(false);
  const removeAll = async () => {
    if (!confirm(`确定删除全部 ${images.length} 张代码卡？`)) return;
    setRemovingAll(true);
    setError("");
    try {
      for (const img of images) {
        await removeImage.mutateAsync({ imageId: img.id });
      }
      utils.notes.get.invalidate();
    } catch (e) {
      setError(friendlyApiError(e instanceof Error ? e.message : String(e)));
      utils.notes.get.invalidate();
    } finally {
      setRemovingAll(false);
    }
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-medium text-stone-700">代码卡合集</span>
          <Badge variant="outline" className="text-[10px]">共 {images.length} 张</Badge>
          <span className="ml-1 flex items-center gap-0.5 text-[10px] text-stone-400">
            张数
            {Array.from({ length: Math.max(6, images.length) }, (_, k) => k + 1).map((n) => (
              <button
                key={n}
                disabled={setPages.isPending || n === images.length}
                onClick={() => { setError(""); setNotice(""); setPages.mutate({ noteId, kind: "code", pages: n }); }}
                className={`h-5 w-5 rounded border text-[10px] transition-colors ${
                  n === images.length
                    ? "border-orange-400 bg-orange-50 text-orange-600"
                    : "border-stone-200 text-stone-500 hover:border-stone-300"
                } disabled:opacity-60`}
                title={n === images.length ? "当前张数" : `重新分页为 ${n} 张`}
              >
                {setPages.isPending ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : n}
              </button>
            ))}
          </span>
          <span className="text-[10px] text-stone-400">微调对整个合集生效，保存后自动重新分页</span>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={zipBusy} onClick={() => void downloadAll()}>
            <Download className="mr-1.5 h-3.5 w-3.5" />{zipBusy ? " 打包中…" : " 全部 PNG"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-stone-400 hover:text-red-600"
            title="删除整个代码卡合集"
            disabled={removingAll}
            onClick={() => void removeAll()}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 所有分页横向平铺预览 */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {pages.map((pg, i) => (
          <div key={pg.id} className="w-[240px] shrink-0">
            <div
              className="overflow-hidden rounded-lg border border-stone-100 shadow-sm [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: pg.svg }}
            />
            <div className="mt-1 text-center text-[10px] text-stone-400">
              第 {i + 1} / {pages.length} 张
            </div>
          </div>
        ))}
      </div>

      {/* 提示词微调：作用于整个合集 */}
      <div className="mt-3 flex gap-2">
        <Input
          placeholder={llmReady ? "对整个代码合集微调，如：换成 Java、注释再详细点" : "配置 LLM Key 后可用提示词微调"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={!llmReady || editGroup.isPending}
          className="text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && prompt.trim()) {
              editGroup.mutate({ noteId, prompt: prompt.trim() });
            }
          }}
        />
        <Button
          size="sm"
          className="shrink-0 bg-orange-600 hover:bg-orange-700"
          disabled={!llmReady || !prompt.trim() || editGroup.isPending}
          onClick={() => editGroup.mutate({ noteId, prompt: prompt.trim() })}
        >
          {editGroup.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
        </Button>
      </div>
      {images[0]?.lastPrompt && (
        <div className="mt-1.5 text-[10px] text-stone-400">上次微调：{images[0].lastPrompt}</div>
      )}

      {/* 参数微调：编辑合并后的完整代码 */}
      <Collapsible className="mt-2">
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-stone-500 hover:text-stone-800">
          <SlidersHorizontal className="h-3 w-3" /> 参数微调（完整代码）
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-stone-400">标题（分页序号自动添加）</label>
              <Input
                className="h-8 text-xs"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <div>
              <label className="text-[11px] text-stone-400">语言</label>
              <Input
                className="h-8 text-xs"
                value={draft.lang}
                onChange={(e) => setDraft({ ...draft, lang: e.target.value })}
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] text-stone-400">完整代码（保存时自动重新分页成多张卡）</label>
            <Textarea
              className="min-h-40 font-mono text-xs"
              value={draft.code}
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[11px] text-stone-400">底部提示（复杂度）</label>
            <Input
              className="h-8 text-xs"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>
          <div>
            <label className="text-[11px] text-stone-400">配色</label>
            <div className="mt-1 flex gap-1.5">
              {(Object.keys(THEMES) as ThemeName[]).map((name) => (
                <button
                  key={name}
                  className={`h-7 w-7 rounded-full border-2 transition-all ${
                    draft.theme === name ? "scale-110 border-stone-800" : "border-stone-200"
                  }`}
                  style={{ background: `linear-gradient(135deg, ${THEMES[name].bg1}, ${THEMES[name].accent})` }}
                  onClick={() => setDraft({ ...draft, theme: name })}
                  title={name}
                />
              ))}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={updateGroup.isPending}
            onClick={() => updateGroup.mutate({ noteId, spec: draft })}
          >
            {updateGroup.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            保存参数（全部代码页一起更新）
          </Button>
        </CollapsibleContent>
      </Collapsible>

      {notice && <div className="mt-2 rounded bg-green-50 p-2 text-xs text-green-600">{notice}</div>}
      {error && <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
