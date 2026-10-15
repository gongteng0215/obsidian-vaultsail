import type { Revision } from './remote-vault.ts';
import { hash, jsonBytes } from '../core/safety.ts';
export const AUTO_MERGE_DEVICE = '00000000-0000-4000-8000-000000000001';
// A shared automatic-merge namespace and stable UUID-compatible object ID let
// concurrent devices publish exactly the same immutable record, not twins.
export function automaticMergeId(vaultId: string, path: string, parents: string[], contentHash: string, fileId: string): string {
  const hex = hash(jsonBytes(['vaultsail-text-merge-v1', vaultId, path, [...parents].sort(), contentHash, fileId])).slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const id = hex.join(''); return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}

export type MergeChunk = { kind: 'text'; text: string } | { kind: 'conflict'; base: string; local: string; remote: string };
export interface TextMerge { chunks: MergeChunk[]; clean: boolean; text?: string; }
export const MAX_MERGE_BYTES = 256 * 1024;
export function mergeText(data: ArrayBuffer): string | undefined {
  if (data.byteLength > MAX_MERGE_BYTES) return undefined;
  try { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); return text.includes('\0') ? undefined : text; }
  catch { return undefined; }
}
interface Edit { start: number; end: number; lines: string[]; side: 'local' | 'remote'; }
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function edits(base: string[], target: string[], side: Edit['side']): Edit[] | undefined {
  if (base.length > 3000 || target.length > 3000 || (base.length + 1) * (target.length + 1) > 2_000_000) return undefined;
  const width = target.length + 1, lcs = new Uint16Array((base.length + 1) * width);
  for (let i = base.length - 1; i >= 0; i--) for (let j = target.length - 1; j >= 0; j--)
    lcs[i * width + j] = base[i] === target[j] ? 1 + lcs[(i + 1) * width + j + 1] : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  const result: Edit[] = []; let i = 0, j = 0, current: Edit | undefined;
  const flush = () => { if (current) result.push(current); current = undefined; };
  while (i < base.length || j < target.length) {
    if (i < base.length && j < target.length && base[i] === target[j]) { flush(); i++; j++; continue; }
    current ??= { start: i, end: i, lines: [], side };
    if (j < target.length && (i === base.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) current.lines.push(target[j++]);
    else { i++; current.end = i; }
  }
  flush(); return result;
}
export function threeWayMerge(base: string, local: string, remote: string): TextMerge | undefined {
  if ([base, local, remote].some(text => new TextEncoder().encode(text).byteLength > MAX_MERGE_BYTES || text.includes('\0'))) return undefined;
  if (local === remote || base === remote || base === local) {
    const text = local === remote || base === remote ? local : remote; return { chunks: [{ kind: 'text', text }], clean: true, text };
  }
  // Concurrent frontmatter changes need explicit review, even if separate YAML
  // lines happen to merge textually. No claim of semantic Markdown merging.
  const frontmatter = (text: string) => text.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/)?.[0];
  const fm = [base, local, remote].map(frontmatter);
  if (fm.some(Boolean) && fm[1] !== fm[0] && fm[2] !== fm[0]) return { clean: false, chunks: [{ kind: 'conflict', base, local, remote }] };
  const original = lines(base), left = edits(original, lines(local), 'local'), right = edits(original, lines(remote), 'remote');
  if (!left || !right) return undefined;
  const all = [...left, ...right].sort((a, b) => a.start - b.start || a.end - b.end), chunks: MergeChunk[] = []; let cursor = 0;
  for (let index = 0; index < all.length;) {
    const group = [all[index++]], start = group[0].start; let end = group[0].end;
    // Touching ranges are conservatively treated together, including competing
    // insertions at the same boundary. Never choose arbitrary insertion order.
    while (index < all.length && all[index].start <= end) { end = Math.max(end, all[index].end); group.push(all[index++]); }
    if (cursor < start) chunks.push({ kind: 'text', text: original.slice(cursor, start).join('') });
    const apply = (side: Edit['side']) => {
      let position = start; const output: string[] = [];
      for (const edit of group.filter(edit => edit.side === side)) { output.push(...original.slice(position, edit.start), ...edit.lines); position = edit.end; }
      output.push(...original.slice(position, end)); return output.join('');
    };
    const a = apply('local'), b = apply('remote');
    if (!group.some(edit => edit.side === 'local')) chunks.push({ kind: 'text', text: b });
    else if (!group.some(edit => edit.side === 'remote') || a === b) chunks.push({ kind: 'text', text: a });
    else chunks.push({ kind: 'conflict', base: original.slice(start, end).join(''), local: a, remote: b });
    cursor = end;
  }
  if (cursor < original.length) chunks.push({ kind: 'text', text: original.slice(cursor).join('') });
  const clean = chunks.every(chunk => chunk.kind === 'text');
  const text = clean ? chunks.map(chunk => (chunk as { text: string }).text).join('') : undefined;
  if (text !== undefined && new TextEncoder().encode(text).byteLength > MAX_MERGE_BYTES) return undefined;
  return { chunks, clean, ...(text !== undefined ? { text } : {}) };
}
export function commonAncestor(ops: Revision[], tips: string[]): Revision | undefined {
  if (tips.length !== 2) return undefined;
  const byId = new Map(ops.map(op => [op.opId, op]));
  const ancestors = (tip: string) => { const found = new Set<string>(), queue = [tip];
    for (let i = 0; i < queue.length; i++) { const id = queue[i]; if (found.has(id)) continue; const op = byId.get(id); if (!op) return undefined; found.add(id); queue.push(...op.parents); }
    return found;
  };
  const a = ancestors(tips[0]), b = ancestors(tips[1]); if (!a || !b) return undefined;
  const common = new Set([...a].filter(id => b.has(id))), older = new Set<string>();
  // In an ancestor-closed intersection, each parent of a common node is also
  // common. Maximal common nodes are merge-base candidates, not timestamps.
  for (const id of common) for (const parent of byId.get(id)!.parents) older.add(parent);
  const bases = [...common].filter(id => !older.has(id)); return bases.length === 1 ? byId.get(bases[0]) : undefined;
}
