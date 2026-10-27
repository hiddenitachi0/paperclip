import type { ContractType } from "@paperclipai/shared";
import type { Contract } from "../api/contracts";

/**
 * "Is this a new version of a contract we already have?" -- a guess for the
 * upload form only. It pre-selects a likely older contract; the person can
 * change it or say no, and nothing is linked until they save.
 */

const NOISE_WORDS = new Set([
  "the", "and", "for", "new", "newer", "old", "final", "draft", "signed", "copy", "updated", "revised", "version",
  "rev", "agreement", "contract", "pdf", "docx",
]);

function tokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/\.(pdf|docx)$/i, "")
    .split(/[^a-z0-9æøåäöü]+/i)
    .filter((word) => word.length >= 3 && !NOISE_WORDS.has(word) && !/^v?\d+$/.test(word));
  return new Set(words);
}

export function suggestPreviousVersion(
  title: string,
  type: ContractType,
  existing: Contract[],
): Contract | null {
  const wanted = tokens(title);
  if (wanted.size === 0) return null;
  let best: { contract: Contract; score: number } | null = null;
  for (const contract of existing) {
    // A replaced contract already has its newer version; the chain never forks.
    if (contract.status === "superseded" || contract.type !== type) continue;
    const other = tokens(contract.title);
    if (other.size === 0) continue;
    let shared = 0;
    for (const word of wanted) if (other.has(word)) shared += 1;
    const score = shared / (wanted.size + other.size - shared);
    if (score >= 0.5 && (!best || score > best.score)) best = { contract, score };
  }
  return best?.contract ?? null;
}
