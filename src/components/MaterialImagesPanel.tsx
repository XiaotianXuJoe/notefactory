import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { Button } from "@/components/ui/button";
import { Check, ChevronDown, ChevronUp, Download, ImageIcon, ImagePlus, Loader2, X } from "lucide-react";

/** 素材原图面板：展示从飞书文档 / 公众号文章导入的图片，支持放大查看、下载、加为笔记配图 */
export default function MaterialImagesPanel({
  materialId,
  noteId,
  defaultOpen = false,
}: {
  materialId: number;
  /** 传入笔记 ID 时，展示「加为配图」按钮 */
  noteId?: number;
  defaultOpen?: boolean;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(defaultOpen);
  const [preview, setPreview] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<number[]>([]);
  const [addError, setAddError] = useState("");
  const images = trpc.materials.images.useQuery({ id: materialId }, { enabled: open });

  const addToNote = trpc.notes.addMaterialImage.useMutation({
    onSuccess: (_r, vars) => {
      setAddedIds((prev) => [...prev, vars.materialImageId]);
      setAddError("");
      utils.notes.get.invalidate();
    },
    onError: (e) => setAddError(e.message),
  });

  const download = (dataUrl: string, name: string) => {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name || "image.png";
    a.click();
  };

  return (
    <div className="rounded-xl border border-stone-200 bg-white">
      <button
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium text-stone-700"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-1.5">
          <ImageIcon className="h-4 w-4 text-stone-400" />
          素材原图（来自原文）
          {images.data && images.data.length > 0 && (
            <span className="text-xs font-normal text-stone-400">{images.data.length} 张</span>
          )}
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-stone-400" /> : <ChevronDown className="h-4 w-4 text-stone-400" />}
      </button>
      {open && (
        <div className="border-t border-stone-100 p-3">
          {images.isLoading && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-stone-300" />
            </div>
          )}
          {addError && <div className="mb-2 rounded bg-red-50 p-2 text-xs text-red-600">{addError}</div>}
          {images.data && images.data.length === 0 && (
            <div className="py-4 text-center text-xs text-stone-400">该素材没有图片</div>
          )}
          {images.data && images.data.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {images.data.map((img) => (
                <div key={img.id} className="group relative overflow-hidden rounded-lg border border-stone-100 bg-stone-50">
                  <img
                    src={img.dataUrl}
                    alt={img.name}
                    className="h-24 w-full cursor-zoom-in object-contain"
                    onClick={() => setPreview(img.dataUrl)}
                  />
                  <button
                    className="absolute right-1 top-1 rounded-md bg-white/90 p-1 opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
                    title="下载图片"
                    onClick={() => download(img.dataUrl, img.name)}
                  >
                    <Download className="h-3.5 w-3.5 text-stone-600" />
                  </button>
                  {noteId != null && (
                    <button
                      className={`absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 py-1 text-[11px] font-medium transition-colors ${
                        addedIds.includes(img.id)
                          ? "bg-green-600/90 text-white"
                          : "bg-orange-600/90 text-white opacity-0 hover:bg-orange-700/90 group-hover:opacity-100"
                      }`}
                      disabled={addToNote.isPending || addedIds.includes(img.id)}
                      onClick={() => addToNote.mutate({ noteId, materialImageId: img.id })}
                    >
                      {addedIds.includes(img.id) ? (
                        <>
                          <Check className="h-3 w-3" /> 已加入
                        </>
                      ) : (
                        <>
                          <ImagePlus className="h-3 w-3" /> 加为配图
                        </>
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 放大预览 */}
      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
          onClick={() => setPreview(null)}
        >
          <div className="relative max-h-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            <img src={preview} className="max-h-[85vh] rounded-lg bg-white object-contain" />
            <div className="absolute right-2 top-2 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => download(preview, "image.png")}>
                <Download className="mr-1 h-3.5 w-3.5" /> 下载
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPreview(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
