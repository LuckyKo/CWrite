/**
 * CWrite — Storage Module
 * Handles persistence via IndexedDB (Dexie) and localStorage fallback.
 */
import Dexie from 'dexie';

const db = new Dexie('CWriteDB');

db.version(1).stores({
  sessions: '++id, name, createdAt, updatedAt, pinned',
  presets: '++id, name, isBuiltIn',
  appSettings: 'key',
});

// ---- Default Presets ----
const BUILT_IN_PRESETS = [
  {
    name: 'Default',
    isBuiltIn: true,
    systemPrompt: '',
    settings: {
      temperature: 0.8,
      topP: 0.95,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      maxTokens: 2048,
      stopStrings: '',
    },
  },
  {
    name: 'Creative Novelist',
    isBuiltIn: true,
    systemPrompt: 'You are a talented creative fiction writer. Write vivid, immersive prose with rich descriptions, compelling dialogue, and nuanced character development. Avoid clichés and aim for literary quality.',
    settings: {
      temperature: 1.0,
      topP: 0.95,
      topK: 60,
      minP: 0.03,
      repeatPenalty: 1.15,
      maxTokens: 4096,
      stopStrings: '',
    },
  },
  {
    name: 'Dialogue Heavy',
    isBuiltIn: true,
    systemPrompt: 'You are a screenwriter. Focus on sharp, naturalistic dialogue. Keep prose minimal — let characters speak and act. Every line of dialogue should reveal character or advance the story.',
    settings: {
      temperature: 0.85,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      maxTokens: 2048,
      stopStrings: '',
    },
  },
  {
    name: 'Poetic / Lyrical',
    isBuiltIn: true,
    systemPrompt: 'You are a poet and lyrical prose writer. Write with rhythm, metaphor, and emotional resonance. Every sentence should have a musical quality. Embrace brevity and imagery.',
    settings: {
      temperature: 1.1,
      topP: 0.98,
      topK: 80,
      minP: 0.02,
      repeatPenalty: 1.2,
      maxTokens: 2048,
      stopStrings: '',
    },
  },
  {
    name: 'Technical Writer',
    isBuiltIn: true,
    systemPrompt: 'You are a clear, precise technical writer. Write well-structured, informative content. Use proper formatting, headings, and logical flow. Prioritize clarity over style.',
    settings: {
      temperature: 0.5,
      topP: 0.85,
      topK: 30,
      minP: 0.1,
      repeatPenalty: 1.05,
      maxTokens: 2048,
      stopStrings: '',
    },
  },
];

// ---- Sessions ----

export async function getAllSessions() {
  return db.sessions.orderBy('updatedAt').reverse().toArray();
}

export async function getSession(id) {
  return db.sessions.get(id);
}

export async function createSession(name = 'Untitled') {
  const now = Date.now();
  const id = await db.sessions.add({
    name,
    messages: [],
    createdAt: now,
    updatedAt: now,
    pinned: false,
  });
  return db.sessions.get(id);
}

export async function updateSession(id, changes) {
  changes.updatedAt = Date.now();
  await db.sessions.update(id, changes);
  return db.sessions.get(id);
}

export async function deleteSession(id) {
  await db.sessions.delete(id);
}

export async function duplicateSession(id) {
  const session = await db.sessions.get(id);
  if (!session) return null;
  const { id: _id, ...data } = session;
  data.name = session.name + ' (copy)';
  data.createdAt = Date.now();
  data.updatedAt = Date.now();
  const newId = await db.sessions.add(data);
  return db.sessions.get(newId);
}

// ---- Presets ----

export async function initPresets() {
  const count = await db.presets.count();
  if (count === 0) {
    for (const preset of BUILT_IN_PRESETS) {
      await db.presets.add(preset);
    }
  }
}

export async function getAllPresets() {
  return db.presets.toArray();
}

export async function getPreset(id) {
  return db.presets.get(id);
}

export async function savePreset(id, changes) {
  await db.presets.update(id, changes);
  return db.presets.get(id);
}

export async function createPreset(preset) {
  preset.isBuiltIn = false;
  const id = await db.presets.add(preset);
  return db.presets.get(id);
}

export async function deletePreset(id) {
  const preset = await db.presets.get(id);
  if (preset && preset.isBuiltIn) return false;
  await db.presets.delete(id);
  return true;
}

export async function exportPreset(id) {
  const preset = await db.presets.get(id);
  if (!preset) return null;
  const { id: _id, ...data } = preset;
  return JSON.stringify(data, null, 2);
}

export async function importPreset(jsonStr) {
  const data = JSON.parse(jsonStr);
  data.isBuiltIn = false;
  const id = await db.presets.add(data);
  return db.presets.get(id);
}

// ---- App Settings ----

export async function getSetting(key, defaultValue = null) {
  const entry = await db.appSettings.get(key);
  return entry ? entry.value : defaultValue;
}

export async function setSetting(key, value) {
  await db.appSettings.put({ key, value });
}

export { db };
