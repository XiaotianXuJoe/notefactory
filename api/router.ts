import { createRouter, publicQuery } from "./middleware";
import { ensureSchema } from "./queries/ensureSchema";
import { materialsRouter } from "./materialsRouter";
import { notesRouter } from "./notesRouter";
import { settingsRouter } from "./settingsRouter";
import { narrativeRouter } from "./narrativeRouter";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  /** 应用启动/前端加载时确保数据表存在（沙箱无法直连数据库，改为运行时自举） */
  init: publicQuery.mutation(async () => ({ ready: await ensureSchema() })),
  materials: materialsRouter,
  notes: notesRouter,
  settings: settingsRouter,
  narrative: narrativeRouter,
});

export type AppRouter = typeof appRouter;
