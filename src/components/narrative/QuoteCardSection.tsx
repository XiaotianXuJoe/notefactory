/**
 * 叙事工坊：金句卡（5）—— 主题选择 / SVG 预览 / PNG(2160×2880) 与 SVG 下载
 * 渲染参数与旧 public/narrative.html 完全一致（见 themes.ts）。
 */
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { CARD_THEMES, buildCardSVG, downloadCardPNG, downloadCardSVG } from "./themes";
import { NumIcon } from "./DraftSection";

export type CardCfg = { quote: string; sign: string; theme: string };

type Props = {
  card: CardCfg;
  onChange: (card: CardCfg) => void;
  previewRef?: React.RefObject<HTMLDivElement | null>;
};

export default function QuoteCardSection({ card, onChange, previewRef }: Props) {
  const theme = CARD_THEMES[card.theme] ? card.theme : "paper";
  const quote = card.quote.trim();

  function requireQuote(): string | null {
    if (!quote) { toast("请先输入金句"); return null; }
    return buildCardSVG(quote, card.sign.trim(), theme);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <NumIcon n="5" />
          金句卡
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>金句文字</Label>
            <Textarea
              className="min-h-[80px]"
              placeholder="一句最有传播力的话，建议 30 字以内"
              value={card.quote}
              onChange={(e) => onChange({ ...card, quote: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>卡片署名</Label>
            <Input
              maxLength={30}
              value={card.sign}
              onChange={(e) => onChange({ ...card, sign: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>卡片主题</Label>
          <div className="flex flex-wrap gap-3">
            {Object.entries(CARD_THEMES).map(([key, t]) => (
              <button
                key={key}
                type="button"
                onClick={() => onChange({ ...card, theme: key })}
                className={`w-24 rounded-lg border-2 bg-white px-0 pb-2 pt-2.5 text-center text-xs transition-colors ${
                  key === theme ? "border-orange-500" : "border-stone-200 hover:border-stone-300"
                }`}
              >
                <span
                  className="mx-2.5 mb-1.5 flex h-11 items-center justify-center rounded-md border text-[15px] font-semibold"
                  style={{ background: t.bg, color: t.text, borderColor: t.sub + "33" }}
                >
                  金句
                </span>
                {t.name}
              </button>
            ))}
          </div>
        </div>
        <div ref={previewRef} className="flex justify-center rounded-xl bg-stone-100 p-6">
          {quote ? (
            <div
              className="w-[300px] rounded-xl shadow-[0_8px_28px_rgba(28,25,23,.14)] [&>svg]:h-auto [&>svg]:w-full [&>svg]:rounded-xl"
              dangerouslySetInnerHTML={{ __html: buildCardSVG(quote, card.sign.trim(), theme) }}
            />
          ) : (
            <div className="flex min-h-[150px] flex-col items-center justify-center gap-2 px-5 py-8 text-center text-stone-400">
              <div className="text-sm font-medium text-stone-500">
                输入金句后，卡片预览将显示在这里
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button
            className="bg-orange-600 hover:bg-orange-700"
            onClick={() => {
              const svg = requireQuote();
              if (svg) downloadCardPNG(svg, (msg, err) => (err ? toast.error(msg) : toast.success(msg)));
            }}
          >
            下载 PNG（2x 高清）
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const svg = requireQuote();
              if (svg) downloadCardSVG(svg, (msg, err) => (err ? toast.error(msg) : toast.success(msg)));
            }}
          >
            下载 SVG
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
