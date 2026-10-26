import { Link, useLocation } from "react-router";
import { BookOpen, FileText, Home, Settings, Sparkles, Wand2 } from "lucide-react";
import { useEffect } from "react";
import { trpc } from "@/providers/trpc";

const NAV = [
  { to: "/", label: "工作台", icon: Home },
  { to: "/materials", label: "素材库", icon: BookOpen },
  { to: "/notes", label: "笔记", icon: FileText },
  { to: "/settings", label: "设置", icon: Settings },
  { to: "/narrative", label: "叙事工坊", icon: Wand2 },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  // 应用加载时确保数据库表已创建
  const init = trpc.init.useMutation();
  useEffect(() => {
    init.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen bg-[#faf9f7]">
      <aside className="fixed inset-y-0 left-0 z-20 flex w-56 flex-col border-r border-stone-200 bg-white">
        <div className="flex items-center gap-2 border-b border-stone-100 px-5 py-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-stone-900">闭眼笔记工厂</div>
            <div className="text-[11px] text-stone-400">闭着眼睛学数理化</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => {
            const active =
              item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? "bg-orange-50 font-medium text-orange-700"
                    : "text-stone-600 hover:bg-stone-50 hover:text-stone-900"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-stone-100 p-4 text-[11px] leading-4 text-stone-400">
          素材来自飞书公开链接
          <br />
          内容生成后人工审核发布
        </div>
      </aside>
      <main className="ml-56 flex-1 p-8">{children}</main>
    </div>
  );
}
