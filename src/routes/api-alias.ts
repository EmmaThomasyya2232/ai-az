import { Hono } from "hono";
import type { Env } from "../types";
import { requireAdminToken } from "../core/auth";
import {
  importServicePrincipalHandler,
  bootstrapHandler,
  listSubsHandler,
} from "./admin";

/**
 * /api/* 兼容别名 (《计划.md》定义的外部入口):
 *   POST /api/service-principals               -> JSON 粘贴验真 + 订阅自动发现
 *   POST /api/subscriptions/:id/safe-bootstrap -> 一键安全上架流水线
 *   GET  /api/subscriptions                    -> 订阅画像列表
 * 与 /admin 对应端点共用同一处理器 (单一实现), 仍走 ADMIN_TOKEN 鉴权。
 */
export const apiAlias = new Hono<{ Bindings: Env }>();

// 仅拦截本别名的业务路径; /api/health (健康检查) 不需要鉴权
apiAlias.use("/service-principals", requireAdminToken);
apiAlias.use("/subscriptions", requireAdminToken);
apiAlias.use("/subscriptions/*", requireAdminToken);

apiAlias.post("/service-principals", importServicePrincipalHandler);
apiAlias.post("/subscriptions/:id/safe-bootstrap", bootstrapHandler);
apiAlias.get("/subscriptions", listSubsHandler);