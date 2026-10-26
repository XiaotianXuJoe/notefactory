import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Download, Loader2, SlidersHorizontal, Trash2, Wand2 } from "lucide-react";
import { downloadSvgAsPng, renderImageSvg, renderDiagramCardSvg, THEMES, type ThemeName, type ProblemLayoutOverride } from "./imageRender";
import { friendlyApiError } from "@/lib/utils";
import type { ImageSpec, ImageKind, NoteImageKind, NoteImageSpec, PhotoSpec, DiagramSpec, ProblemSpec } from "@contracts/types";
import { IMAGE_KIND_META } from "@contracts/types";

// ---- Mermaid 懒加载：htmlLabels=false 避免 foreignObject 污染 canvas，保证可导出 PNG ----
let mermaidReady: Promise<typeof import("mermaid")> | null = null;
function getMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false, // 必须为 false：否则生成 foreignObject，canvas 导出 PNG 会被污染
      });
      return m;
    });
  }
  return mermaidReady;
}
let mermaidSeq = 0;

const KIND_LABEL: Record<NoteImageKind, string> = {
  ...(Object.fromEntries(IMAGE_KIND_META.map((m) => [m.kind, m.label])) as Record<ImageKind, string>),
  photo: "素材插图",
};

/** 全局脏标记集合：任何卡片/编辑器有未保存修改时登记 id，页面 beforeunload 时拦截防误关 */
export const __dirtySet = (() => {
  const KEY = "__nfDirty";
  return (
    (window as any)[KEY] instanceof Set ||
      (((window as any)[KEY] = new Set()),
      window.addEventListener("beforeunload", (e) => {
        (window as any)[KEY].size && (e.preventDefault(), (e.returnValue = ""));
      })),
    (id: string, dirty: boolean) => {
      dirty ? (window as any)[KEY].add(id) : (window as any)[KEY].delete(id);
    }
  );
})();

type Props = {
  image: {
    id: number;
    kind: NoteImageKind;
    spec: NoteImageSpec;
    version: number;
    lastPrompt: string | null;
  };
  llmReady: boolean;
};

export default function NoteImageCard({ image, llmReady }: Props) {
  const utils = trpc.useUtils();
  const [prompt, setPrompt] = useState("");
  const [spec, setSpec] = useState<NoteImageSpec>(image.spec);
  const [error, setError] = useState("");

  // 服务端改写 spec 后（AI 生图完成/失败）同步到本地；
  // 依赖内容签名而非对象引用，避免轮询 refetch 产生新引用时覆盖未保存的本地修改
  const specSig = JSON.stringify(image.spec);
  const syncRef = useRef(specSig);
  // 本地有未保存修改时（cur 与两个签名都不同）不覆盖；否则跟随服务端并记录同步点
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const cur = JSON.stringify(spec);
    (cur === specSig || cur === syncRef.current) && ((syncRef.current = specSig), setSpec(image.spec));
  }, [specSig]);
  // 登记脏标记：本地 spec 与服务端不一致时，关闭页面前 beforeunload 拦截
  useEffect(() => {
    __dirtySet("img:" + image.id, JSON.stringify(spec) !== specSig);
    return () => __dirtySet("img:" + image.id, false);
  }, [spec, specSig, image.id]);

  const isPhoto = spec.kind === "photo";
  const photoSpec = isPhoto ? (spec as PhotoSpec) : null;
  const isAiPhoto = isPhoto && photoSpec?.source === "ai";
  const isGenerating = !!photoSpec?.generating;
  const isDiagram = spec.kind === "diagram";
  const displayLabel = isAiPhoto ? "AI 生图" : KIND_LABEL[image.kind];

  // 流程图：异步用 mermaid 渲染，成功后包进 3:4 卡片
  const [diagramSvg, setDiagramSvg] = useState("");
  const [diagramErr, setDiagramErr] = useState("");
  useEffect(() => {
    if (!isDiagram) return;
    let alive = true;
    setDiagramErr("");
    setDiagramSvg("");
    getMermaid()
      .then((m) => m.default.render(`mmd-${image.id}-${++mermaidSeq}`, (spec as DiagramSpec).mermaid))
      .then((out) => {
        if (alive) setDiagramSvg(out.svg);
      })
      .catch((e: unknown) => {
        if (alive) setDiagramErr(e instanceof Error ? e.message.split("\n")[0] : "Mermaid 渲染失败");
      });
    return () => {
      alive = false;
    };
  }, [isDiagram, spec, image.id]);

  const svg = useMemo(() => {
    if (isDiagram) {
      if (diagramSvg) return renderDiagramCardSvg(diagramSvg, spec as DiagramSpec);
      if (diagramErr) return renderImageSvg(spec); // 占位卡
      return renderImageSvg(spec); // 渲染中占位卡
    }
    return renderImageSvg(spec);
  }, [isDiagram, diagramSvg, diagramErr, spec]);

  const editByPrompt = trpc.notes.editImageByPrompt.useMutation({
    onSuccess: (r) => {
      setSpec(r.spec as ImageSpec);
      setPrompt("");
      setError("");
      utils.notes.get.invalidate();
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const [savedNotice, setSavedNotice] = useState(false);
  const updateSpec = trpc.notes.updateImageSpec.useMutation({
    onSuccess: () => {
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2000);
      utils.notes.get.invalidate();
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const removeImage = trpc.notes.removeImage.useMutation({
    onSuccess: () => utils.notes.get.invalidate(),
    onError: (e) => setError(friendlyApiError(e.message)),
  });
  const regenAi = trpc.notes.regenAiImage.useMutation({
    onSuccess: () => {
      setPrompt("");
      setError("");
      utils.notes.get.invalidate();
    },
    onError: (e) => setError(friendlyApiError(e.message)),
  });

  const set = (patch: Partial<ImageSpec>) => {
    const next = { ...spec, ...patch } as NoteImageSpec;
    setSpec(next);
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-stone-700">{displayLabel}</span>
          <Badge variant="outline" className="text-[10px]">v{image.version}</Badge>
        </div>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={isGenerating || (isPhoto && !photoSpec?.dataUrl) || (isDiagram && !diagramSvg)}
            onClick={() => downloadSvgAsPng(svg, `${displayLabel}-v${image.version}.png`)}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" /> PNG
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-stone-400 hover:text-red-600"
            title="删除这张图"
            onClick={() => {
              if (confirm("确定删除这张配图？")) removeImage.mutate({ imageId: image.id });
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 预览：生成中/失败占位，正常时渲染 SVG */}
      {isGenerating ? (
        <div className="mx-auto flex aspect-[3/4] w-full max-w-[280px] flex-col items-center justify-center gap-2 rounded-lg border border-violet-200 bg-violet-50/60">
          <Loader2 className="h-6 w-6 animate-spin text-violet-500" />
          <div className="text-xs text-violet-600">AI 正在画图中…</div>
          <div className="px-4 text-center text-[10px] leading-4 text-stone-400">
            约需 30-60 秒，可继续编辑其他内容；超过 2 分钟未完成可在下方改描述重试
          </div>
        </div>
      ) : (
        <div
          className="mx-auto w-full max-w-[280px] overflow-hidden rounded-lg border border-stone-100 shadow-sm [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {photoSpec?.error && (
        <div className="mt-2 rounded bg-red-50 p-2 text-xs leading-4 text-red-600">
          生成失败：{friendlyApiError(photoSpec.error)}（可在下方改描述后点右侧按钮重试）
        </div>
      )}
      {diagramErr && (
        <div className="mt-2 rounded bg-red-50 p-2 text-xs leading-4 text-red-600">
          Mermaid 语法有误：{diagramErr}（可在「参数微调」里直接改代码）
        </div>
      )}

      {/* 提示词改图（素材插图为原图，不支持） */}
      {!isPhoto && (
        <>
          <div className="mt-3 flex gap-2">
        <Input
          placeholder={llmReady ? "如：封面换成蓝色、标题改成…" : "配置 LLM Key 后可用提示词改图"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={!llmReady || editByPrompt.isPending}
          className="text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter" && prompt.trim()) {
              editByPrompt.mutate({ imageId: image.id, prompt: prompt.trim() });
            }
          }}
        />
        <Button
          size="sm"
          className="shrink-0 bg-orange-600 hover:bg-orange-700"
          disabled={!llmReady || !prompt.trim() || editByPrompt.isPending}
          onClick={() => editByPrompt.mutate({ imageId: image.id, prompt: prompt.trim() })}
        >
          {editByPrompt.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
        </Button>
      </div>
      {image.lastPrompt && (
        <div className="mt-1.5 text-[10px] text-stone-400">上次修改：{image.lastPrompt}</div>
      )}
        </>
      )}
      {isAiPhoto && (
        <>
          <div className="mt-3 flex gap-2">
            <Input
              placeholder="修改画面描述；留空则按原描述重新生成"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={regenAi.isPending}
              className="text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !regenAi.isPending) {
                  const p = prompt.trim();
                  regenAi.mutate(p ? { imageId: image.id, prompt: p } : { imageId: image.id });
                }
              }}
            />
            <Button
              size="sm"
              className="shrink-0 bg-violet-600 hover:bg-violet-700"
              title={prompt.trim() ? "按新描述重新生成" : "按原描述重新生成"}
              disabled={regenAi.isPending}
              onClick={() => {
                const p = prompt.trim();
                regenAi.mutate(p ? { imageId: image.id, prompt: p } : { imageId: image.id });
              }}
            >
              {regenAi.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            </Button>
          </div>
          <div className="mt-1.5 text-[10px] leading-4 text-stone-400">
            当前描述：{(spec as PhotoSpec).prompt ?? "（无记录）"}
          </div>
        </>
      )}
      {isPhoto && !isAiPhoto && (
        <div className="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-[11px] leading-relaxed text-stone-500">
          这是素材中的原图（{(spec as PhotoSpec).name}），可直接下载使用；如需参数化模板图请用「添加配图」生成。
        </div>
      )}

      {/* 参数微调（素材插图无参数） */}
      {!isPhoto && (
      <Collapsible className="mt-2">
        <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-stone-500 hover:text-stone-800">
          <SlidersHorizontal className="h-3 w-3" /> 参数微调
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          <div>
            <label className="text-[11px] text-stone-400">标题</label>
            <Input
              className="h-8 text-xs"
              value={spec.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </div>
          {spec.kind === "cover" && (
            <>
              <div>
                <label className="text-[11px] text-stone-400">角标</label>
                <Input className="h-8 text-xs" value={spec.tag} onChange={(e) => set({ tag: e.target.value })} />
              </div>
              <div>
                <label className="text-[11px] text-stone-400">副标题</label>
                <Input className="h-8 text-xs" value={spec.subtitle} onChange={(e) => set({ subtitle: e.target.value })} />
              </div>
            </>
          )}
          {spec.kind === "steps" && (
            <div>
              <label className="text-[11px] text-stone-400">步骤（每行：步骤名|说明）</label>
              <Textarea
                className="min-h-20 font-mono text-xs"
                value={spec.steps.map((s) => `${s.t}|${s.d}`).join("\n")}
                onChange={(e) =>
                  set({
                    steps: e.target.value
                      .split("\n")
                      .map((l) => l.split("|"))
                      .filter((p) => p[0]?.trim())
                      .map((p) => ({ t: p[0].trim(), d: (p[1] ?? "").trim() })),
                  } as Partial<ImageSpec>)
                }
              />
            </div>
          )}
          {spec.kind === "quote" && (
            <>
              <div>
                <label className="text-[11px] text-stone-400">金句</label>
                <Textarea
                  className="min-h-16 text-xs"
                  value={spec.quote}
                  onChange={(e) => set({ quote: e.target.value } as Partial<ImageSpec>)}
                />
              </div>
              <div>
                <label className="text-[11px] text-stone-400">底部补充</label>
                <Input className="h-8 text-xs" value={spec.sub} onChange={(e) => set({ sub: e.target.value } as Partial<ImageSpec>)} />
              </div>
            </>
          )}
          {spec.kind === "list" && (
            <div>
              <label className="text-[11px] text-stone-400">要点（每行一条，3-7 条）</label>
              <Textarea
                className="min-h-24 text-xs"
                value={spec.items.join("\n")}
                onChange={(e) => set({ items: e.target.value.split("\n").filter((l) => l.trim()) } as Partial<ImageSpec>)}
              />
            </div>
          )}
          {spec.kind === "compare" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-stone-400">左栏标签</label>
                  <Input className="h-8 text-xs" value={spec.leftLabel} onChange={(e) => set({ leftLabel: e.target.value } as Partial<ImageSpec>)} />
                </div>
                <div>
                  <label className="text-[11px] text-stone-400">右栏标签</label>
                  <Input className="h-8 text-xs" value={spec.rightLabel} onChange={(e) => set({ rightLabel: e.target.value } as Partial<ImageSpec>)} />
                </div>
              </div>
              <div>
                <label className="text-[11px] text-stone-400">左栏要点（每行一条）</label>
                <Textarea
                  className="min-h-16 text-xs"
                  value={spec.leftPoints.join("\n")}
                  onChange={(e) => set({ leftPoints: e.target.value.split("\n").filter((l) => l.trim()) } as Partial<ImageSpec>)}
                />
              </div>
              <div>
                <label className="text-[11px] text-stone-400">右栏要点（每行一条）</label>
                <Textarea
                  className="min-h-16 text-xs"
                  value={spec.rightPoints.join("\n")}
                  onChange={(e) => set({ rightPoints: e.target.value.split("\n").filter((l) => l.trim()) } as Partial<ImageSpec>)}
                />
              </div>
            </>
          )}
          {spec.kind === "diagram" && (
            <div>
              <label className="text-[11px] text-stone-400">Mermaid 代码（节点文字用双引号包裹，改动实时预览）</label>
              <Textarea
                className="min-h-28 font-mono text-xs"
                value={spec.mermaid}
                spellCheck={false}
                onChange={(e) => set({ mermaid: e.target.value } as Partial<ImageSpec>)}
              />
            </div>
          )}
          {spec.kind === "end" && (
            <>
              <div>
                <label className="text-[11px] text-stone-400">引导语（每行一条，2-3 行）</label>
                <Textarea
                  className="min-h-16 text-xs"
                  value={spec.lines.join("\n")}
                  onChange={(e) => set({ lines: e.target.value.split("\n").filter((l) => l.trim()) } as Partial<ImageSpec>)}
                />
              </div>
              <div>
                <label className="text-[11px] text-stone-400">底部按钮文字（留空默认「关注 @闭着眼睛学数理化」，宽度自适应）</label>
                <Input
                  className="h-8 text-xs"
                  value={(spec as { cta?: string }).cta ?? ""}
                  placeholder="关注 @闭着眼睛学数理化"
                  onChange={(e) => set({ cta: e.target.value } as Partial<ImageSpec>)}
                />
              </div>
            </>
          )}
          {spec.kind === "problem" && (
            <div>
              <label className="text-[11px] text-stone-400">题目描述文字（空行分段；用 **文字** 加粗，如 **输入描述**：）</label>
              <Textarea
                className="min-h-32 text-xs leading-relaxed"
                value={spec.text}
                spellCheck={false}
                onChange={(e) => set({ text: e.target.value } as Partial<ImageSpec>)}
              />
              <div className="flex items-center gap-4 pt-1">
                <label className="flex items-center gap-1.5 text-[11px] text-stone-400">
                  行距
                  <Input
                    className="h-7 w-16 px-1.5 text-xs"
                    type="number"
                    step="0.05"
                    min="1.1"
                    max="2.2"
                    value={(spec as ProblemSpec & ProblemLayoutOverride).lineGap ?? ""}
                    placeholder="自动"
                    onChange={(e) => set({ lineGap: e.target.value === "" ? undefined : parseFloat(e.target.value) || undefined } as Partial<ImageSpec>)}
                  />
                  <span className="text-stone-300">留空自动</span>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-stone-400">
                  段距
                  <Input
                    className="h-7 w-16 px-1.5 text-xs"
                    type="number"
                    step="0.1"
                    min="0"
                    max="3"
                    value={(spec as ProblemSpec & ProblemLayoutOverride).paraGap ?? 1}
                    onChange={(e) => set({ paraGap: e.target.value === "" ? undefined : parseFloat(e.target.value) } as Partial<ImageSpec>)}
                  />
                  <span className="text-stone-300">倍行高</span>
                </label>
              </div>
            </div>
          )}
          {spec.kind === "code" && (
            <>
              <div>
                <label className="text-[11px] text-stone-400">代码</label>
                <Textarea
                  className="min-h-28 font-mono text-xs"
                  value={spec.code}
                  onChange={(e) => set({ code: e.target.value } as Partial<ImageSpec>)}
                />
              </div>
              <div>
                <label className="text-[11px] text-stone-400">底部提示（复杂度）</label>
                <Input
                  className="h-8 text-xs"
                  value={spec.note}
                  onChange={(e) => set({ note: e.target.value } as Partial<ImageSpec>)}
                />
              </div>
            </>
          )}
          <div>
            <label className="text-[11px] text-stone-400">配色</label>
            <div className="mt-1 flex gap-1.5">
              {(Object.keys(THEMES) as ThemeName[]).map((name) => (
                <button
                  key={name}
                  className={`h-7 w-7 rounded-full border-2 transition-all ${
                    spec.theme === name ? "scale-110 border-stone-800" : "border-stone-200"
                  }`}
                  style={{ background: `linear-gradient(135deg, ${THEMES[name].bg1}, ${THEMES[name].accent})` }}
                  onClick={() => set({ theme: name })}
                  title={name}
                />
              ))}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={updateSpec.isPending}
            onClick={() => updateSpec.mutate({ imageId: image.id, spec: spec as ImageSpec })}
          >
            {updateSpec.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {savedNotice ? "已保存 ✓" : "保存参数"}
            {JSON.stringify(spec) !== specSig && <span className="ml-1.5 text-xs text-amber-500">未保存 ●</span>}
          </Button>
        </CollapsibleContent>
      </Collapsible>
      )}

      {error && <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
