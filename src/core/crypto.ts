import type { Env } from "../types";
import { ConfigError } from "./config";

/**
 * 凭据静态加密 (AES-GCM, WebCrypto):
 * 主密钥来自 Secret CREDENTIAL_ENCRYPTION_KEY (32 字节, 64 位 hex 或 base64)。
 * 密文格式 "v1:<iv_b64>:<ciphertext_b64>", 版本前缀便于日后轮换算法/密钥。
 */

const PREFIX = "v1";
const IV_LENGTH = 12; // AES-GCM 推荐 96-bit IV

function decodeKeyMaterial(secret: string): Uint8Array {
  const s = secret.trim();
  // 64 位 hex
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return raw;
  }
  // base64
  try {
    const bin = atob(s);
    if (bin.length === 32) {
      const raw = new Uint8Array(32);
      for (let i = 0; i < 32; i++) raw[i] = bin.charCodeAt(i);
      return raw;
    }
  } catch {
    /* not base64 */
  }
  throw new ConfigError(
    "CREDENTIAL_ENCRYPTION_KEY must be 32 bytes: 64 hex chars (openssl rand -hex 32) or base64"
  );
}

async function importAesKey(env: Env): Promise<CryptoKey> {
  const secret = env.CREDENTIAL_ENCRYPTION_KEY ?? "";
  if (secret.trim() === "") {
    throw new ConfigError("CREDENTIAL_ENCRYPTION_KEY is not configured");
  }
  const raw = decodeKeyMaterial(secret);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** AES-GCM 加密, 每次使用随机 IV */
export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await importAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${PREFIX}:${toB64(iv)}:${toB64(new Uint8Array(ct))}`;
}

/** 解密 encryptSecret 产生的密文; 格式非法或密钥不匹配时抛 ConfigError */
export async function decryptSecret(env: Env, stored: string): Promise<string> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    throw new ConfigError("Stored credential has unknown format");
  }
  const key = await importAesKey(env);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(parts[1]) },
      key,
      fromB64(parts[2])
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new ConfigError(
      "Failed to decrypt stored credential (wrong CREDENTIAL_ENCRYPTION_KEY?)"
    );
  }
}

/** 管理面板展示用脱敏: 仅保留末 4 位 */
export function maskSecret(secret: string): string {
  return secret.length >= 4 ? `***${secret.slice(-4)}` : "***";
}

/** SHA-256 摘要 (hex)。用于网关 Key / Admin Token 的常量时间安全比较与落库去明文化。 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

