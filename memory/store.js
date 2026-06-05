import fs from "fs";
import path from "path";
import { MEMORY_MAX_EPISODES, MEMORY_MAX_PROFILE } from "../constants.js";

export function memoryDir() {
  return process.env.MEMORY_DIR || "memory";
}

function safeUserId(userId) {
  return String(userId).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function memoryPath(userId) {
  return path.join(memoryDir(), `${safeUserId(userId)}.json`);
}

export function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function emptyMemory(userId) {
  return { version: 1, userId, profile: [], episodes: [], updatedAt: 0 };
}

export function loadMemory(userId) {
  try {
    const raw = fs.readFileSync(memoryPath(userId), "utf-8");
    const data = JSON.parse(raw);
    return { ...emptyMemory(userId), ...data, userId };
  } catch {
    return emptyMemory(userId);
  }
}

export function saveMemory(userId, memory) {
  fs.mkdirSync(memoryDir(), { recursive: true });
  const file = memoryPath(userId);
  const tmp = `${file}.tmp`;
  const data = { ...emptyMemory(userId), ...memory, userId, updatedAt: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
  return data;
}

function normText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

export function applyNewFacts(memory, facts, cap = MEMORY_MAX_PROFILE) {
  const next = { ...memory, profile: [...(memory.profile || [])] };
  const existing = new Set(next.profile.map(item => normText(item.text)));
  for (const raw of facts || []) {
    const text = normText(typeof raw === "string" ? raw : raw?.text);
    if (!text || existing.has(text)) continue;
    existing.add(text);
    const now = Date.now();
    next.profile.push({ id: genId("p"), text, createdAt: now, updatedAt: now, hits: 0 });
  }
  if (next.profile.length > cap) {
    next.profile.sort((a, b) => (a.hits - b.hits) || (a.createdAt - b.createdAt));
    next.profile = next.profile.slice(next.profile.length - cap);
  }
  return next;
}

export function addEpisode(memory, summary, tags = [], cap = MEMORY_MAX_EPISODES) {
  const text = normText(summary);
  if (!text) return memory;
  const next = { ...memory, episodes: [...(memory.episodes || [])] };
  next.episodes.unshift({ id: genId("e"), summary: text, tags: Array.isArray(tags) ? tags : [], ts: Date.now() });
  if (next.episodes.length > cap) next.episodes = next.episodes.slice(0, cap);
  return next;
}

export function touchProfile(memory, ids) {
  const selected = new Set(ids || []);
  return {
    ...memory,
    profile: (memory.profile || []).map(item => selected.has(item.id)
      ? { ...item, hits: (item.hits || 0) + 1, updatedAt: Date.now() }
      : item),
  };
}
