import crypto from "crypto";
import {
  FILE_ANCHOR_MAX_CHARS,
  FILE_ANCHOR_TOTAL_CHARS,
  FILE_ANCHOR_MAX_FILES,
  FILE_IDLE_EVICT_TURNS,
} from "./constants.js";

function makeFileId(fileName, content) {
  const hash = crypto.createHash("sha1").update(`${fileName}\n${content}`).digest("hex").slice(0, 10);
  return `f_${hash}`;
}

function normalizeFile(file) {
  const text = String(file.text || "");
  return {
    id: file.id || makeFileId(file.fileName || "file", text),
    fileName: file.fileName || "未命名文件",
    content: text.slice(0, FILE_ANCHOR_MAX_CHARS),
    idleTurns: 0,
  };
}

export function buildFileAnchors(files) {
  const step1 = (files || []).slice(0, FILE_ANCHOR_MAX_FILES).map(normalizeFile);
  const total = step1.reduce((sum, file) => sum + file.content.length, 0);
  if (total <= FILE_ANCHOR_TOTAL_CHARS) return step1;
  const ratio = FILE_ANCHOR_TOTAL_CHARS / total;
  return step1.map(file => ({ ...file, content: file.content.slice(0, Math.floor(file.content.length * ratio)) }));
}

export function upsertFileAnchors(existing = [], newFiles = []) {
  const byId = new Map((existing || []).map(file => [file.id, { ...file }]));
  for (const file of buildFileAnchors(newFiles)) {
    byId.set(file.id, file);
  }
  return Array.from(byId.values()).slice(-FILE_ANCHOR_MAX_FILES);
}

export function selectFilesByIds(files = [], selectedIds = []) {
  const ids = new Set(selectedIds || []);
  return files.filter(file => ids.has(file.id));
}

export function ageFileAnchors(files = [], selectedIds = [], evictTurns = FILE_IDLE_EVICT_TURNS) {
  const selected = new Set(selectedIds || []);
  return (files || [])
    .map(file => selected.has(file.id)
      ? { ...file, idleTurns: 0 }
      : { ...file, idleTurns: (file.idleTurns || 0) + 1 })
    .filter(file => file.idleTurns < evictTurns);
}

export function filesForProbe(files = []) {
  return {
    count: files.length,
    total_chars: files.reduce((sum, file) => sum + (file.content?.length || 0), 0),
    names: files.map(file => file.fileName),
    ids: files.map(file => file.id),
    idle_turns: files.map(file => file.idleTurns || 0),
  };
}
