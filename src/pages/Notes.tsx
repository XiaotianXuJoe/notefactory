import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FlaskConical } from "lucide-react";

export default function Notes() {
  const list = trpc.notes.list.useQuery();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900">笔记</h1>
        <p className="mt-1 text-sm text-stone-500">AI 生成的草稿在这里审核、修改、导出。</p>
      </div>

      <div className="space-y-3">
        {list.isPending && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-stone-200 bg-stone-50" />
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
            还没有笔记。去<Link to="/materials" className="text-orange-600 hover:underline">素材库</Link>生成第一篇吧
          </div>
        )}
        {list.data?.map((n) => (
          <Link key={n.id} to={`/notes/${n.id}`}>
            <Card className="transition-shadow hover:shadow-md">
              <CardContent className="py-4">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-stone-800">{n.title || "（未命名）"}</span>
                  {n.isDemo && (
                    <Badge variant="outline" className="border-amber-300 text-amber-600">
                      <FlaskConical className="mr-1 h-3 w-3" /> 演示
                    </Badge>
                  )}
                  <Badge
                    className={
                      n.status === "published"
                        ? "bg-green-100 text-green-700 hover:bg-green-100"
                        : "bg-stone-100 text-stone-600 hover:bg-stone-100"
                    }
                  >
                    {n.status === "published" ? "已发布" : "草稿"}
                  </Badge>
                </div>
                <div className="mt-1.5 line-clamp-2 text-xs leading-5 text-stone-500">{n.bodyPreview}</div>
                <div className="mt-2 flex items-center gap-2 text-[11px] text-stone-400">
                  <span>更新于 {new Date(n.updatedAt).toLocaleString("zh-CN")}</span>
                  {n.tags.slice(0, 4).map((t) => (
                    <span key={t} className="rounded bg-stone-100 px-1.5 py-0.5">#{t}</span>
                  ))}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
