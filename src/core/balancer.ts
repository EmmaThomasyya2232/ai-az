import type { AzureNode } from "../types";

const MAX_WEIGHT = 10;

/**
 * 轮询 + 加权优先调度器 (isolate 内计数, Phase 1 足够)。
 * candidates() 返回按轮询起点展开去重后的候选序列,
 * 调用方按序尝试即可实现自动故障转移。
 */
export class Balancer {
  private rr = 0;

  constructor(private readonly nodes: AzureNode[]) {}

  candidates(modelAlias: string): AzureNode[] {
    const pool = this.nodes.filter(
      (n) => n.enabled !== false && !!n.deployments[modelAlias]
    );
    if (pool.length === 0) return [];

    // 按权重展开 (weight=3 的节点在序列中出现 3 次)
    const expanded: AzureNode[] = [];
    for (const n of pool) {
      const w = Math.max(1, Math.min(MAX_WEIGHT, Math.floor(n.weight ?? 1)));
      for (let i = 0; i < w; i++) expanded.push(n);
    }

    const start = this.rr++ % expanded.length;
    const ordered = [...expanded.slice(start), ...expanded.slice(0, start)];

    // 去重, 保持顺序
    const seen = new Set<string>();
    const unique: AzureNode[] = [];
    for (const n of ordered) {
      if (!seen.has(n.name)) {
        seen.add(n.name);
        unique.push(n);
      }
    }
    return unique;
  }
}
