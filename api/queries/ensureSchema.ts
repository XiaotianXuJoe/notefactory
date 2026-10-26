/**
 * 表结构自举：沙箱环境无法直连平台数据库，
 * 因此在服务启动时按 db/schema.ts 对应的 DDL 做 CREATE TABLE IF NOT EXISTS。
 * 注意：此处 DDL 必须与 db/schema.ts 保持一致。
 */
import { sql } from "drizzle-orm";
import fs from "node:fs";
import { getDb } from "./connection";

/** 一次性迁移：叙事工坊 JSON 文件 → MariaDB（表为空且文件存在时才导入；文件保留作备份） */
async function migrateNarrativeJson(): Promise<void> {
  const db = getDb();
  const readJson = (p: string): Record<string, unknown> | null => {
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf-8"));
      return d && typeof d === "object" && !Array.isArray(d) ? d : null;
    } catch {
      return null;
    }
  };
  try {
    const styleRows = await db.execute(sql`SELECT COUNT(*) AS c FROM narrative_style`);
    const styleCount = Number((styleRows as unknown as [Record<string, unknown>[]])[0]?.[0]?.c ?? 0);
    if (styleCount === 0) {
      const d = readJson("/app/data/narrative_style_store.json");
      if (d) {
        const samples = JSON.stringify(Array.isArray(d.samples) ? d.samples : []);
        const profile = d.profile ? String(d.profile) : null;
        const enabled = d.enabled ? 1 : 0;
        const prompt = d.prompt ? String(d.prompt) : null;
        await db.execute(
          sql`INSERT INTO narrative_style (samples, profile, enabled, prompt) VALUES (${samples}, ${profile}, ${enabled}, ${prompt})`,
        );
        console.log("[ensureSchema] 叙事工坊风格档案已从 JSON 迁入 MariaDB");
      }
    }
    const stateRows = await db.execute(sql`SELECT COUNT(*) AS c FROM narrative_state`);
    const stateCount = Number((stateRows as unknown as [Record<string, unknown>[]])[0]?.[0]?.c ?? 0);
    if (stateCount === 0) {
      const d = readJson("/app/data/narrative_state.json");
      if (d) {
        const str = (v: unknown) => (typeof v === "string" && v ? v : null);
        const obj = (v: unknown) =>
          v && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : null;
        await db.execute(
          sql`INSERT INTO narrative_state (prompt, note_type, note_goal, topic, material, draft, card) VALUES (${str(
            d.prompt,
          )}, ${str(d.type)}, ${str(d.goal)}, ${str(d.topic)}, ${str(d.material)}, ${obj(d.draft)}, ${obj(d.card)})`,
        );
        console.log("[ensureSchema] 叙事工坊工作区状态已从 JSON 迁入 MariaDB");
      }
    }
  } catch (e) {
    console.warn("[ensureSchema] 叙事工坊 JSON 迁移跳过：", (e as Error).message);
  }
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS materials (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    title varchar(512) NOT NULL,
    source_type enum('link','paste') NOT NULL,
    source_url varchar(1024),
    content mediumtext NOT NULL,
    status enum('ready','failed') NOT NULL DEFAULT 'ready',
    error_msg varchar(1024),
    skeleton mediumtext,
    angles text,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    material_id bigint unsigned,
    title varchar(255) NOT NULL DEFAULT '',
    title_candidates text,
    body mediumtext NOT NULL,
    tags text,
    status enum('draft','published') NOT NULL DEFAULT 'draft',
    qc_report text,
    is_demo boolean NOT NULL DEFAULT false,
    ai_style varchar(32) NOT NULL DEFAULT 'flat',
    svg_theme varchar(32),
    sync_status varchar(16) NOT NULL DEFAULT 'none',
    sync_error text,
    synced_at timestamp NULL,
    sync_payload longtext,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS note_images (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    note_id bigint unsigned NOT NULL,
    kind enum('cover','steps','code') NOT NULL,
    spec mediumtext NOT NULL,
    sort_order int NOT NULL DEFAULT 0,
    version int NOT NULL DEFAULT 1,
    last_prompt text,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS material_images (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    material_id bigint unsigned NOT NULL,
    token varchar(128) NOT NULL,
    name varchar(512) NOT NULL DEFAULT '',
    mime varchar(64) NOT NULL DEFAULT 'image/png',
    width int NOT NULL DEFAULT 0,
    height int NOT NULL DEFAULT 0,
    sort_order int NOT NULL DEFAULT 0,
    data_base64 mediumtext NOT NULL,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS note_sync_images (
    note_id bigint unsigned NOT NULL,
    idx int NOT NULL,
    name varchar(120) NOT NULL DEFAULT '',
    data_url longtext NOT NULL,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (note_id, idx)
  )`,
  `CREATE TABLE IF NOT EXISTS narrative_style (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    samples mediumtext NOT NULL,
    profile mediumtext,
    enabled boolean NOT NULL DEFAULT false,
    prompt mediumtext,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS narrative_state (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    prompt mediumtext,
    note_type varchar(128),
    note_goal varchar(128),
    topic varchar(1024),
    material mediumtext,
    draft mediumtext,
    card mediumtext,
    created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    skey varchar(64) NOT NULL,
    svalue text,
    updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY settings_skey_unique (skey)
  )`,
];

/** 幂等的结构演进语句（对老库补齐新枚举值等），失败仅告警不影响启动 */
const MIGRATIONS = [
  `ALTER TABLE note_images MODIFY COLUMN kind enum('cover','steps','code','quote','list','compare','diagram','end','photo') NOT NULL`,
  `ALTER TABLE notes ADD COLUMN ai_style varchar(32) NOT NULL DEFAULT 'flat'`,
  `ALTER TABLE notes ADD COLUMN svg_theme varchar(32) NULL`,
  `ALTER TABLE materials ADD COLUMN skeleton mediumtext NULL`,
  `ALTER TABLE materials ADD COLUMN angles text NULL`,
  `ALTER TABLE notes ADD COLUMN sync_status varchar(16) NOT NULL DEFAULT 'none'`,
  `ALTER TABLE notes ADD COLUMN sync_error text NULL`,
  `ALTER TABLE notes ADD COLUMN synced_at timestamp NULL`,
  `ALTER TABLE notes ADD COLUMN sync_payload longtext NULL`,
  `ALTER TABLE note_images MODIFY COLUMN kind enum('cover','steps','code','problem','quote','list','compare','diagram','end','photo') NOT NULL`,
];

let ensured = false;
let lastError: string | null = null;

export function getSchemaError(): string | null {
  return lastError;
}

export async function ensureSchema(): Promise<boolean> {
  if (ensured) return true;
  try {
    const db = getDb();
    // 整体 8 秒超时：连接挂起时快速失败，避免拖垮整个请求
    await Promise.race([
      (async () => {
        for (const stmt of DDL) {
          await db.execute(sql.raw(stmt));
        }
        for (const stmt of MIGRATIONS) {
          try {
            await db.execute(sql.raw(stmt));
          } catch (me) {
            console.warn("[ensureSchema] 结构演进跳过：", (me as Error).message);
          }
        }
        await migrateNarrativeJson();
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("数据库连接超时（8 秒），实例可能处于休眠状态")), 8_000),
      ),
    ]);
    ensured = true;
    lastError = null;
    console.log("[ensureSchema] 数据表就绪");
    return true;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    lastError = err.cause?.message ?? err.message;
    console.warn("[ensureSchema] 数据库暂不可用：", lastError);
    return false;
  }
}
