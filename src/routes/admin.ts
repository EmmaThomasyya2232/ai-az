import { Hono } from "hono";
import type { Env } from "../types";

export const admin = new Hono<{ Bindings: Env }>();

// Phase 4 将扩展为完整管理 API (JWT 鉴权 / 凭据 / 实例 / 部署管理)
admin.get("/health", (c) =>
  c.json({ ok: true, service: "azure-ai-manager", time: new Date().toISOString() })
);
