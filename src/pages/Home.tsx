import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowRight, BookOpen, FileText, FlaskConical, KeyRound } from "lucide-react";

export default function Home() {
  const materials = trpc.materials.list.useQuery(undefined, { retry: 1 });
  const notesList = trpc.notes.list.useQuery(undefined, { retry: 1 });
  const settings = trpc.settings.get.useQuery(undefined, { retry: 1 });

  const materialCount = materials.data?.length ?? 0;
  const noteCount = notesList.data?.length ?? 0;
  const draftCount = notesList.data?.filter((n) => n.status === "draft").length ?? 0;
  const llmReady = settings.data?.llmConfigured ?? false;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900">工作台</h1>
        <p className="mt-1 text-sm text-stone-500">
          飞书素材 → AI 生成小红书图文 → 人工审核 → 导出发布
        </p>
      </div>

      {!llmReady && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="flex items-center gap-3 py-4">
            <KeyRound className="h-5 w-5 shrink-0 text-amber-600" />
            <div className="flex-1 text-sm text-amber-800">
              尚未配置 LLM API Key，当前为<strong>演示模式</strong>（模板拼装内容）。配置
              Moonshot 等 OpenAI 兼容接口的 Key 后即可启用完整 AI 生成。
            </div>
            <Link to="/settings">
              <Button size="sm" variant="outline" className="border-amber-300">
                去配置
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-stone-500">
              <BookOpen className="h-4 w-4" /> 素材库
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-stone-900">{materialCount}</div>
            <div className="mt-1 text-xs text-stone-400">篇题解素材</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-stone-500">
              <FileText className="h-4 w-4" /> 笔记
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-stone-900">{noteCount}</div>
            <div className="mt-1 text-xs text-stone-400">{draftCount} 篇待审核</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-stone-500">
              <FlaskConical className="h-4 w-4" /> 生成引擎
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${llmReady ? "text-green-600" : "text-amber-500"}`}>
              {llmReady ? "AI" : "演示"}
            </div>
            <div className="mt-1 text-xs text-stone-400">{llmReady ? "LLM 已接入" : "等待配置 Key"}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">使用流程</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-stone-600">
          {[
            ["① 导入素材", "在「素材库」粘贴飞书文档公开链接（需开启「互联网获得链接的人可阅读」），或直接粘贴文本", "/materials"],
            ["② 生成笔记", "在素材卡片上点「生成笔记」，AI 会产出 5 个候选标题 + 六段式正文 + 标签 + 3 张配图", "/materials"],
            ["③ 审核修改", "在笔记编辑器里直接改文案，配图支持「提示词改图」和参数微调，右侧实时质检", "/notes"],
            ["④ 导出发布", "一键复制小红书格式文案 + 下载 PNG 配图，到小红书 App 人工发布", "/notes"],
          ].map(([title, desc, to]) => (
            <Link key={title} to={to} className="flex items-start gap-3 rounded-lg border border-stone-100 p-3 transition-colors hover:border-orange-200 hover:bg-orange-50/50">
              <div className="flex-1">
                <div className="font-medium text-stone-800">{title}</div>
                <div className="mt-0.5 text-xs leading-5 text-stone-500">{desc}</div>
              </div>
              <ArrowRight className="mt-1 h-4 w-4 text-stone-300" />
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
