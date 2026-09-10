#!/usr/bin/env node
/**
 * 一键部署脚本 (npm run setup):
 *   1. 检测 Cloudflare 登录状态 (未登录则提示 `npx wrangler login` 后重试)
 *   2. 查找/创建 D1 数据库, 并把 database_id 自动回填到 wrangler.jsonc
 *   3. 应用远程 D1 迁移 (migrations/*.sql)
 *   4. 检查缺失的 Secrets, 自动生成 ADMIN_TOKEN / CREDENTIAL_ENCRYPTION_KEY / GATEWAY_KEYS
 *   5. wrangler deploy 并打印访问地址与密钥汇总
 *
 * 可选参数 (覆盖自动生成的值):
 *   npm run setup -- --admin-token=xxx --gateway-keys=sk-az-a,sk-az-b \
 *                    --cred-key=<64hex> --azure-nodes='[...]' --skip-deploy
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = path.join(ROOT, "wrangler.jsonc");
const DB_NAME = "azure-ai-manager";
const PLACEHOLDER_ID = "REPLACE_WITH_YOUR_D1_DATABASE_ID";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

// ---------- 终端输出 ----------
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const step = (n, msg) => console.log(`\n${bold(cyan(`[步骤 ${n}]`))} ${msg}`);
const info = (msg) => console.log(`  ${msg}`);
const warn = (msg) => console.log(`  ${yellow("⚠ " + msg)}`);
const die = (msg) => {
  console.error(`\n${red("✘ " + msg)}`);
  process.exit(1);
};

// ---------- CLI 参数 ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([a-z-]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

// ---------- 子进程工具 ----------
/** 执行命令 (继承 stdio, 失败即退出) */
function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", cwd: ROOT });
  if (r.status !== 0) die(`命令失败: ${cmd} ${cmdArgs.join(" ")} (exit ${r.status})`);
}

/** 执行命令并捕获 stdout (失败返回 null, 不退出) */
function capture(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"], cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

/** 从命令输出中提取 JSON 数组 (容忍夹杂的日志行) */
function extractJsonArray(text) {
  if (!text) return null;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------- 步骤实现 ----------
function checkLogin() {
  const out = capture(NPX, ["wrangler", "whoami"]) ?? "";
  if (/not authenticated/i.test(out) || out === "") {
    die(
      "未登录 Cloudflare。请先运行:\n\n    npx wrangler login\n\n" +
        "  (浏览器授权后重新运行 npm run setup; 无浏览器环境可用 CLOUDFLARE_API_TOKEN 环境变量代替)",
    );
  }
  info(green("已登录 Cloudflare ✓"));
}

function ensureD1() {
  const list = extractJsonArray(capture(NPX, ["wrangler", "d1", "list", "--json"]));
  const found = Array.isArray(list) ? list.find((d) => d.name === DB_NAME) : null;
  if (found?.uuid) {
    info(`复用已有 D1 数据库 ${bold(DB_NAME)} (${dim(found.uuid)})`);
    return found.uuid;
  }
  info(`未找到 D1 数据库, 正在创建 ${bold(DB_NAME)} ...`);
  run(NPX, ["wrangler", "d1", "create", DB_NAME]);
  const again = extractJsonArray(capture(NPX, ["wrangler", "d1", "list", "--json"]));
  const created = Array.isArray(again) ? again.find((d) => d.name === DB_NAME) : null;
  if (!created?.uuid) die(`D1 数据库 ${DB_NAME} 创建后未能获取 uuid, 请检查 wrangler 输出`);
  info(green(`D1 创建成功 (${created.uuid})`));
  return created.uuid;
}

function patchConfig(databaseId) {
  let content;
  try {
    content = readFileSync(WRANGLER_CONFIG, "utf8");
  } catch {
    die(`无法读取 ${WRANGLER_CONFIG}`);
  }
  const idRegex = /("database_id"\s*:\s*")([^"]*)(")/;
  const m = content.match(idRegex);
  if (!m) die(`${WRANGLER_CONFIG} 中未找到 database_id 字段`);
  if (m[2] === databaseId) {
    info("database_id 已是当前值, 跳过回填");
    return;
  }
  if (m[2] && m[2] !== PLACEHOLDER_ID) {
    warn(`wrangler.jsonc 已配置 database_id=${m[2]}, 与实际库 (${databaseId}) 不一致, 将以实际库为准回填`);
  }
  writeFileSync(WRANGLER_CONFIG, content.replace(idRegex, `$1${databaseId}$3`), "utf8");
  info(green("已把 database_id 回填到 wrangler.jsonc"));
}

function applyMigrations() {
  run(NPX, ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);
  info(green("D1 迁移已应用 ✓"));
}

/** 已配置的 Secrets 名单 (Worker 尚未创建时视为空) */
function existingSecrets() {
  const list = extractJsonArray(capture(NPX, ["wrangler", "secret", "list", "--json"]));
  return new Set(Array.isArray(list) ? list.map((s) => s.name) : []);
}

function putSecret(name, value) {
  const r = spawnSync(NPX, ["wrangler", "secret", "put", name], {
    input: `${value}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    cwd: ROOT,
  });
  if (r.status !== 0) die(`写入 Secret ${name} 失败`);
}

function ensureSecrets() {
  const have = existingSecrets();
  const generated = [];

  const plan = [
    {
      name: "ADMIN_TOKEN",
      existsMsg: "已配置, 跳过 (如需更换请用 wrangler secret put ADMIN_TOKEN)",
      make: () => randomBytes(24).toString("hex"),
      arg: args["admin-token"],
      track: true,
    },
    {
      name: "CREDENTIAL_ENCRYPTION_KEY",
      existsMsg: "已配置, 跳过 (注意: 更换该密钥会导致已加密凭据无法解密)",
      make: () => randomBytes(32).toString("hex"),
      arg: args["cred-key"],
      track: false,
    },
    {
      name: "GATEWAY_KEYS",
      existsMsg: "已配置, 跳过 (也可稍后在面板发放新 Key)",
      make: () => `sk-az-${randomBytes(16).toString("hex")}`,
      arg: args["gateway-keys"],
      track: true,
    },
  ];

  for (const item of plan) {
    if (have.has(item.name)) {
      info(`${bold(item.name)}: ${dim(item.existsMsg)}`);
      continue;
    }
    const value = String(item.arg ?? item.make());
    if (!item.arg) generated.push({ name: item.name, value, track: item.track });
    info(`写入 Secret ${bold(item.name)} ...`);
    putSecret(item.name, value);
  }

  if (args["azure-nodes"]) {
    info(`写入 Secret ${bold("AZURE_NODES")} ...`);
    putSecret("AZURE_NODES", String(args["azure-nodes"]));
  } else {
    info(
      `${bold("AZURE_NODES")}: ${dim("跳过 (可选)。部署后可在面板「节点池 / Azure 资源浏览器」中添加节点, 凭据加密落库")}`,
    );
  }

  return generated;
}

// ---------- 主流程 ----------
console.log(bold(cyan("\n╔══════════════════════════════════════════╗")));
console.log(bold(cyan("║  Azure AI Manager · 一键部署到 Workers   ║")));
console.log(bold(cyan("╚══════════════════════════════════════════╝")));

step(1, "检查 Cloudflare 登录状态");
checkLogin();

step(2, "准备 D1 数据库");
const databaseId = ensureD1();
patchConfig(databaseId);

step(3, "应用 D1 迁移 (远程)");
applyMigrations();

step(4, "配置 Secrets");
const generated = ensureSecrets();

let workerUrl = "";
if (args["skip-deploy"]) {
  warn("已按 --skip-deploy 跳过部署");
} else {
  step(5, "部署到 Cloudflare Workers");
  const out = capture(NPX, ["wrangler", "deploy"]) ?? "";
  console.log(out || dim("(无输出)"));
  const m = out.match(/https:\/\/[a-z0-9.-]*workers\.dev\S*/i);
  if (m) workerUrl = m[0];
}

console.log(`\n${bold(green("✅ 部署完成!"))}\n`);
if (workerUrl) {
  console.log(`  面板/网关地址: ${bold(cyan(workerUrl))}`);
  console.log(`  健康检查:      ${dim(`curl ${workerUrl}/admin/health`)}`);
}
if (generated.length) {
  console.log(`\n  ${bold("以下自动生成的凭据仅显示这一次, 请妥善保存:")}\n`);
  for (const g of generated) {
    if (g.track) console.log(`  ${g.name} = ${bold(green(g.value))}`);
  }
  console.log(`\n  ${dim("首次打开面板时输入 ADMIN_TOKEN 即可登录 (只保存在浏览器 localStorage)。")}`);
  console.log(`  ${dim("接下来: 打开面板 → 节点池/Azure 资源浏览器 添加节点 → 网关密钥 发放 Key。")}`);
}
console.log("");

