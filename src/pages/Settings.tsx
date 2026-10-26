import { useEffect, useRef, useState } from "react";
import { trpc } from "@/providers/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plug, Save } from "lucide-react";

export default function Settings() {
  const settings = trpc.settings.get.useQuery();
  const [form, setForm] = useState({
    llmBaseUrl: "",
    llmApiKey: "",
    llmModel: "",
    llmDisableThinking: false,
    llmTemperature: "",
    imgBaseUrl: "",
    imgApiKey: "",
    imgModel: "",
    personaPrompt: "",
    styleSamples: "",
  });
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 只在首次加载时填充表单：保存后的 refetch 不得覆盖用户继续编辑的内容
  const formInited = useRef(false);
  useEffect(() => {
    if (settings.data && !formInited.current) {
      formInited.current = true;
      setForm({
        llmBaseUrl: settings.data.llmBaseUrl,
        llmApiKey: settings.data.llmApiKey,
        llmModel: settings.data.llmModel,
        llmDisableThinking: settings.data.llmDisableThinking,
        llmTemperature: settings.data.llmTemperature,
        imgBaseUrl: settings.data.imgBaseUrl,
        imgApiKey: settings.data.imgApiKey,
        imgModel: settings.data.imgModel,
        personaPrompt: settings.data.personaPrompt,
        styleSamples: settings.data.styleSamples,
      });
    }
  }, [settings.data]);

  const [saveError, setSaveError] = useState("");
  const update = trpc.settings.update.useMutation({
    onSuccess: () => {
      setSaved(true);
      setSaveError("");
      setTimeout(() => setSaved(false), 2000);
    },
    onError: (e) => setSaveError(e.message),
  });
  const test = trpc.settings.testLlm.useMutation({
    onSuccess: (r) => setTestResult(r),
    onError: (e) => setTestResult({ ok: false, message: e.message }),
  });
  const diag = trpc.settings.diagEgress.useMutation({
    onSuccess: (r) => setTestResult(r),
    onError: (e) => setTestResult({ ok: false, message: e.message }),
  });
  const diagDb = trpc.settings.diagDb.useMutation({
    onSuccess: (r) => setDbDiag(r),
    onError: (e) => setDbDiag({ ok: false, message: e.message }),
  });
  const [dbDiag, setDbDiag] = useState<{ ok: boolean; message: string } | null>(null);
  // 文生图 API 测试：独立的结果状态，与 LLM 的 testResult 互不覆盖
  const [imgTestResult, setImgTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const testImg = trpc.settings.testImage.useMutation({
    onSuccess: (r) => setImgTestResult(r),
    onError: (e) => setImgTestResult({ ok: false, message: e.message }),
  });
  const diagImg = trpc.settings.diagEgress.useMutation({
    onSuccess: (r) => setImgTestResult(r),
    onError: (e) => setImgTestResult({ ok: false, message: e.message }),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-stone-900">设置</h1>
        <p className="mt-1 text-sm text-stone-500">配置 LLM 接口和账号人设提示词。</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">LLM 接口（OpenAI 兼容）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="text-xs text-stone-500">Base URL（两套体系，Key 不通用，选你创建 Key 的那个平台）</label>
            <Input
              value={form.llmBaseUrl}
              onChange={(e) => setForm({ ...form, llmBaseUrl: e.target.value })}
              placeholder="https://api.moonshot.cn/v1"
            />
            <div className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-stone-400">
              <div>· Kimi 开放平台（platform.moonshot.cn，按量付费）→ <code className="rounded bg-stone-100 px-1">https://api.moonshot.cn/v1</code></div>
              <div>· kimi.com 的 Kimi Code（会员订阅）→ <code className="rounded bg-stone-100 px-1">https://api.kimi.com/coding/v1</code></div>
            </div>
          </div>
          <div>
            <label className="text-xs text-stone-500">API Key</label>
            <Input
              type="password"
              value={form.llmApiKey}
              onChange={(e) => setForm({ ...form, llmApiKey: e.target.value })}
              placeholder="sk-..."
            />
          </div>
          <div>
            <label className="text-xs text-stone-500">模型</label>
            <Input
              value={form.llmModel}
              onChange={(e) => setForm({ ...form, llmModel: e.target.value })}
              placeholder="kimi-k3"
            />
            <div className="mt-1.5 text-[11px] leading-4 text-stone-400">
              开放平台可用 kimi-k3 / kimi-k2.6 等；Kimi Code 端点可用 kimi-for-coding / kimi-k3 等，以控制台模型列表为准
            </div>
          </div>
          <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-stone-700">
              <input
                type="checkbox"
                className="h-4 w-4 accent-orange-600"
                checked={form.llmDisableThinking}
                onChange={(e) => setForm({ ...form, llmDisableThinking: e.target.checked })}
              />
              关闭模型思考（显著提速，推荐）
            </label>
            <p className="mt-1 pl-6 text-[11px] leading-4 text-stone-400">
              思考型模型（如 kimi-k2.6）推理耗时很长，可能超时或耗尽输出预算；关闭后响应更快更稳。若所用端点不支持该参数会自动回退，不影响使用。
            </p>
          </div>
          <div>
            <label className="text-xs text-stone-500">温度（temperature）</label>
            <Input
              type="number"
              step="0.1"
              min="0"
              max="2"
              className="w-40"
              value={form.llmTemperature}
              onChange={(e) => setForm({ ...form, llmTemperature: e.target.value })}
              placeholder="留空 = 自动"
            />
            <div className="mt-1.5 text-[11px] leading-4 text-stone-400">
              留空时按模型自动：<b>关闭思考的 kimi-k2.6 必须用 0.6</b>；思考模式的 k2.6 / kimi-k3 等思考模型只能用 1。手动填写后始终以你填的为准（0 ~ 2）
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={test.isPending}
              onClick={() => {
                setTestResult(null);
                // 直接测试表单当前值，无需先保存
                test.mutate({
                  llmBaseUrl: form.llmBaseUrl,
                  llmApiKey: form.llmApiKey,
                  llmModel: form.llmModel,
                });
              }}
            >
              {test.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plug className="mr-1.5 h-4 w-4" />}
              测试连接
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-stone-500"
              disabled={diag.isPending}
              onClick={() => {
                setTestResult(null);
                diag.mutate(form.llmBaseUrl.trim() ? { url: form.llmBaseUrl.trim() } : undefined);
              }}
            >
              {diag.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              网络诊断
            </Button>
            {testResult && (
              <span className={`text-xs leading-4 ${testResult.ok ? "text-green-600" : "text-red-600"}`}>
                {testResult.message}
                {testResult.ok && "（别忘了点下方「保存设置」）"}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">文生图 API（可选，用于 AI 生图配图）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-stone-400">
            配置后，笔记编辑器的「添加配图」里可以用自然语言直接生成封面氛围图/插图（竖版 3:4）。
            代码卡、步骤卡等信息图仍走模板渲染，无需此项。
          </p>
          <div>
            <label className="text-xs text-stone-500">Base URL</label>
            <Input
              value={form.imgBaseUrl}
              onChange={(e) => setForm({ ...form, imgBaseUrl: e.target.value })}
              placeholder="https://ark.cn-beijing.volces.com/api/v3"
            />
            <div className="mt-1.5 space-y-0.5 text-[11px] leading-4 text-stone-400">
              <div>· 火山引擎方舟（即梦 Seedream，中文渲染最好）→ <code className="rounded bg-stone-100 px-1">https://ark.cn-beijing.volces.com/api/v3</code></div>
              <div>· 智谱（CogView，便宜）→ <code className="rounded bg-stone-100 px-1">https://open.bigmodel.cn/api/paas/v4</code></div>
            </div>
          </div>
          <div>
            <label className="text-xs text-stone-500">API Key</label>
            <Input
              type="password"
              value={form.imgApiKey}
              onChange={(e) => setForm({ ...form, imgApiKey: e.target.value })}
              placeholder="在对应平台控制台创建"
            />
          </div>
          <div>
            <label className="text-xs text-stone-500">图片模型</label>
            <Input
              value={form.imgModel}
              onChange={(e) => setForm({ ...form, imgModel: e.target.value })}
              placeholder="doubao-seedream-4-0-250828"
            />
            <div className="mt-1.5 text-[11px] leading-4 text-stone-400">
              火山引擎填 doubao-seedream-4-0-250828；智谱填 cogview-3-flash（以各平台控制台模型 ID 为准）
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={testImg.isPending}
              title="真实调用接口生成一张极简测试图，验证 Key / 模型 / 参数（约 15-60 秒，消耗一次出图额度）"
              onClick={() => {
                setImgTestResult(null);
                // 直接测试表单当前值，无需先保存
                testImg.mutate({
                  imgBaseUrl: form.imgBaseUrl,
                  imgApiKey: form.imgApiKey,
                  imgModel: form.imgModel,
                });
              }}
            >
              {testImg.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plug className="mr-1.5 h-4 w-4" />}
              测试连接
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-stone-500"
              disabled={diagImg.isPending}
              title="只检测服务器能否访问该地址，不带 Key、不消耗额度"
              onClick={() => {
                setImgTestResult(null);
                diagImg.mutate(form.imgBaseUrl.trim() ? { url: form.imgBaseUrl.trim() } : undefined);
              }}
            >
              {diagImg.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              网络诊断
            </Button>
            {imgTestResult && (
              <span className={`text-xs leading-4 ${imgTestResult.ok ? "text-green-600" : "text-red-600"}`}>
                {imgTestResult.message}
                {imgTestResult.ok && "（别忘了点下方「保存设置」）"}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">人设提示词</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-stone-400">
            定义「闭着眼睛学数理化」的口吻、结构和格式要求，生成时每篇笔记都会带上。
          </p>
          <Textarea
            className="min-h-64 font-mono text-xs leading-5"
            value={form.personaPrompt}
            onChange={(e) => setForm({ ...form, personaPrompt: e.target.value })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">爆款范文（Few-shot 样本）</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-stone-400">
            粘贴 1-2 篇你账号历史高赞笔记的全文，AI 生成时会对齐它们的语气和结构。这是风格对齐性价比最高的一步。
          </p>
          <Textarea
            className="min-h-40 font-mono text-xs leading-5"
            placeholder="粘贴历史爆款笔记全文…"
            value={form.styleSamples}
            onChange={(e) => setForm({ ...form, styleSamples: e.target.value })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">数据库诊断</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-stone-400">
            如果素材导入/保存失败，点这里逐步检测：建表 → 读表 → 写入 → 长文本写入，会显示失败的具体步骤和根因。
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={diagDb.isPending}
              onClick={() => {
                setDbDiag(null);
                diagDb.mutate();
              }}
            >
              {diagDb.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              开始诊断
            </Button>
            {dbDiag && (
              <span className={`text-xs leading-4 ${dbDiag.ok ? "text-green-600" : "text-red-600"}`}>
                {dbDiag.message}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Button
        className="bg-orange-600 hover:bg-orange-700"
        disabled={update.isPending}
        onClick={() => update.mutate(form)}
      >
        {update.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
        {saved ? "已保存" : "保存设置"}
      </Button>
      {saveError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{saveError}</div>
      )}
    </div>
  );
}
