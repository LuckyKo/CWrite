/**
 * CWrite — Main Application
 * Wires together all modules: editor, API, storage, UI interactions.
 */
import { marked } from 'marked';
import {
  getAllSessions, getSession, createSession, updateSession,
  deleteSession, duplicateSession, initPresets, getAllPresets,
  getPreset, savePreset, createPreset, deletePreset,
  exportPreset, importPreset, getSetting, setSetting,
} from './storage.js';
import { llmClient } from './api.js';
import { slopDetector } from './slop.js';

// ---- Configure marked ----
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ---- App State ----
const state = {
  currentSessionId: null,
  messages: [], // [{role, content, id}]
  isGenerating: false,
  isRawEditMode: false,
  currentPresetId: null,
  streamingContent: '',   // content accumulated during streaming
  lastGenSnapshot: null,  // { msgIndex, contentBefore, wasNewMessage } — tracks what was there before last generation
  findQuery: '',          // current search text
  autoSaveTimer: null,
};

// ---- DOM References ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {};

function cacheDom() {
  dom.editor = $('#editor');
  dom.sessionList = $('#session-list');
  dom.presetSelect = $('#preset-select');
  dom.statusWords = $('#status-words');
  dom.statusChars = $('#status-chars');
  dom.statusSave = $('#status-save');
  dom.statusModel = $('#status-model');
  dom.statusTokensSec = $('#status-tokens-sec');
  dom.statusTtft = $('#status-ttft');
  dom.statusGenInfo = $('#status-gen-info');
  dom.panelSessions = $('#panel-sessions');
  dom.panelSettings = $('#panel-settings');
  dom.contextGaugeFill = $('#context-gauge-fill');
  dom.contextGaugeLabel = $('#context-gauge-label');
  dom.findBar = $('#find-bar');
}

// ---- Initialization ----
async function init() {
  cacheDom();
  await initPresets();
  await loadAppSettings();
  await loadPresetList();
  await loadSessionList();

  // Load last active session or create new one
  const lastSessionId = await getSetting('lastSessionId');
  if (lastSessionId) {
    await loadSession(lastSessionId);
  }
  if (!state.currentSessionId) {
    const sessions = await getAllSessions();
    if (sessions.length > 0) {
      await loadSession(sessions[0].id);
    } else {
      const session = await createSession('New Session');
      await loadSession(session.id);
      await loadSessionList();
    }
  }

  bindEvents();
  renderEditor();
  updateWordCount();

  // Show empty state if no messages
  if (state.messages.length === 0) {
    showEmptyState();
  }
}

// ---- Settings ----
async function loadAppSettings() {
  const endpoint = await getSetting('endpoint', 'http://localhost:5001/v1');
  const apiKey = await getSetting('apiKey', '');
  const model = await getSetting('model', '');

  $('#setting-endpoint').value = endpoint;
  $('#setting-api-key').value = apiKey;
  $('#setting-model').value = model;

  llmClient.configure({ endpoint, apiKey, model });

  // Sampling defaults from current preset
  const presetId = await getSetting('currentPresetId');
  if (presetId) {
    state.currentPresetId = presetId;
    await applyPreset(presetId);
  }

  // Slop settings
  const slopEnabled = await getSetting('slopEnabled', true);
  const slopThreshold = await getSetting('slopThreshold', 3);
  const slopRollback = await getSetting('slopRollback', false);
  const slopParagraph = await getSetting('slopParagraph', false);
  $('#setting-slop-enabled').checked = slopEnabled;
  $('#setting-slop-threshold').value = slopThreshold;
  $('#val-slop-threshold').textContent = slopThreshold;
  $('#setting-slop-rollback').checked = slopRollback;
  $('#setting-slop-paragraph').checked = slopParagraph;
  slopDetector.configure({ enabled: slopEnabled, threshold: slopThreshold, autoRollback: slopRollback, paragraphRollback: slopParagraph });

  // Author's Note
  const authorNote = await getSetting('authorNote', '');
  const authorDepth = await getSetting('authorDepth', 2);
  const authorEnabled = await getSetting('authorEnabled', false);
  $('#setting-author-note').value = authorNote;
  $('#setting-author-depth').value = authorDepth;
  $('#val-author-depth').textContent = authorDepth;
  $('#setting-author-enabled').checked = authorEnabled;

  // Context Size
  const contextSize = await getSetting('contextSize', 8192);
  $('#setting-context-size').value = contextSize;

  // Appearance
  const fontSize = await getSetting('fontSize', 16);
  $('#setting-font-size').value = fontSize;
  $('#val-font-size').textContent = fontSize;
  document.documentElement.style.setProperty('--font-size-base', `${fontSize}px`);

  const userColor = await getSetting('userMsgColor', null);
  const assistantColor = await getSetting('assistantMsgColor', null);
  if (userColor) {
    $('#setting-user-color').value = userColor;
    document.documentElement.style.setProperty('--bg-user-msg', userColor);
  }
  if (assistantColor) {
    $('#setting-assistant-color').value = assistantColor;
    document.documentElement.style.setProperty('--bg-assistant-msg', assistantColor);
  }

  // Theme
  const theme = await getSetting('theme', 'dark');
  document.documentElement.setAttribute('data-theme', theme);

  // Panel states
  const sessionsCollapsed = await getSetting('sessionsCollapsed', false);
  const settingsCollapsed = await getSetting('settingsCollapsed', false);
  if (sessionsCollapsed) dom.panelSessions.classList.add('collapsed');
  if (settingsCollapsed) dom.panelSettings.classList.add('collapsed');

  // Update model status
  dom.statusModel.textContent = model || 'No model';
}

function getCurrentSamplingParams() {
  return {
    temperature: parseFloat($('#setting-temperature').value),
    topP: parseFloat($('#setting-top-p').value),
    topK: parseInt($('#setting-top-k').value),
    minP: parseFloat($('#setting-min-p').value),
    repeatPenalty: parseFloat($('#setting-repeat-penalty').value),
    maxTokens: parseInt($('#setting-max-tokens').value),
    stopStrings: $('#setting-stop-strings').value,
  };
}

function getSystemPrompt() {
  return $('#setting-system-prompt').value.trim();
}

// ---- Presets ----
async function loadPresetList() {
  const presets = await getAllPresets();
  dom.presetSelect.innerHTML = '';
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name + (p.isBuiltIn ? '' : ' ✦');
    dom.presetSelect.appendChild(opt);
  }
  if (state.currentPresetId) {
    dom.presetSelect.value = state.currentPresetId;
  }
}

async function applyPreset(presetId) {
  const preset = await getPreset(presetId);
  if (!preset) return;

  state.currentPresetId = presetId;
  dom.presetSelect.value = presetId;
  await setSetting('currentPresetId', presetId);

  // Apply system prompt
  $('#setting-system-prompt').value = preset.systemPrompt || '';

  // Apply sampling settings
  const s = preset.settings || {};
  if (s.temperature !== undefined) {
    $('#setting-temperature').value = s.temperature;
    $('#val-temperature').textContent = s.temperature;
  }
  if (s.topP !== undefined) {
    $('#setting-top-p').value = s.topP;
    $('#val-top-p').textContent = s.topP;
  }
  if (s.topK !== undefined) {
    $('#setting-top-k').value = s.topK;
    $('#val-top-k').textContent = s.topK;
  }
  if (s.minP !== undefined) {
    $('#setting-min-p').value = s.minP;
    $('#val-min-p').textContent = s.minP;
  }
  if (s.repeatPenalty !== undefined) {
    $('#setting-repeat-penalty').value = s.repeatPenalty;
    $('#val-repeat-penalty').textContent = s.repeatPenalty;
  }
  if (s.maxTokens !== undefined) {
    $('#setting-max-tokens').value = s.maxTokens;
  }
  if (s.stopStrings !== undefined) {
    $('#setting-stop-strings').value = s.stopStrings;
  }
}

// ---- Sessions ----
async function loadSessionList() {
  const sessions = await getAllSessions();
  dom.sessionList.innerHTML = '';

  if (sessions.length === 0) {
    dom.sessionList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-tertiary); font-size: 13px;">No sessions yet</div>';
    return;
  }

  // Pinned first, then by updatedAt
  const sorted = [...sessions].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.updatedAt - a.updatedAt;
  });

  for (const s of sorted) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === state.currentSessionId ? ' active' : '');
    item.dataset.id = s.id;

    const pin = s.pinned ? '📌 ' : '';
    const date = new Date(s.updatedAt).toLocaleDateString();

    item.innerHTML = `
      <span class="session-name">${pin}${escapeHtml(s.name)}</span>
      <span class="session-date">${date}</span>
    `;

    item.addEventListener('click', () => loadSession(s.id));

    // Right-click context menu
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showSessionContextMenu(e, s);
    });

    dom.sessionList.appendChild(item);
  }
}

async function loadSession(id) {
  const session = await getSession(id);
  if (!session) return;

  state.currentSessionId = session.id;
  state.messages = session.messages || [];
  state.lastGenSnapshot = null;

  await setSetting('lastSessionId', session.id);
  renderEditor();
  updateWordCount();
  updateContextGauge();
  highlightActiveSession();
}

function highlightActiveSession() {
  $$('.session-item').forEach(item => {
    item.classList.toggle('active', parseInt(item.dataset.id) === state.currentSessionId);
  });
}

function showSessionContextMenu(e, session) {
  // Remove any existing context menu
  const existing = $('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.cssText = `
    position: fixed; left: ${e.clientX}px; top: ${e.clientY}px;
    background: var(--bg-elevated); border: 1px solid var(--border-default);
    border-radius: var(--radius-md); padding: 4px; z-index: 200;
    box-shadow: var(--shadow-md); min-width: 150px;
  `;

  const actions = [
    { label: '✏️ Rename', action: () => renameSession(session) },
    { label: session.pinned ? '📌 Unpin' : '📌 Pin', action: () => togglePinSession(session) },
    { label: '📋 Duplicate', action: () => duplicateAndLoad(session.id) },
    { label: '🗑️ Delete', action: () => confirmDeleteSession(session) },
  ];

  for (const { label, action } of actions) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      display: block; width: 100%; text-align: left; padding: 6px 10px;
      background: none; border: none; color: var(--text-primary);
      font-size: 13px; cursor: pointer; border-radius: var(--radius-sm);
      font-family: var(--font-body);
    `;
    btn.addEventListener('mouseenter', () => btn.style.background = 'var(--bg-hover)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'none');
    btn.addEventListener('click', () => { menu.remove(); action(); });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', closeMenu); }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 10);
}

async function renameSession(session) {
  const name = prompt('Session name:', session.name);
  if (name && name.trim()) {
    await updateSession(session.id, { name: name.trim() });
    await loadSessionList();
  }
}

async function togglePinSession(session) {
  await updateSession(session.id, { pinned: !session.pinned });
  await loadSessionList();
}

async function duplicateAndLoad(id) {
  const newSession = await duplicateSession(id);
  if (newSession) {
    await loadSessionList();
    await loadSession(newSession.id);
  }
}

async function confirmDeleteSession(session) {
  if (confirm(`Delete "${session.name}"?`)) {
    await deleteSession(session.id);
    if (state.currentSessionId === session.id) {
      state.currentSessionId = null;
      state.messages = [];
    }
    await loadSessionList();
    const sessions = await getAllSessions();
    if (sessions.length > 0) {
      await loadSession(sessions[0].id);
    } else {
      const ns = await createSession('New Session');
      await loadSession(ns.id);
      await loadSessionList();
    }
  }
}

// ---- Editor Rendering ----
function renderEditor() {
  if (state.messages.length === 0) {
    showEmptyState();
    return;
  }

  dom.editor.innerHTML = '';
  for (let i = 0; i < state.messages.length; i++) {
    const msg = state.messages[i];
    const block = createMessageBlock(msg, i);
    dom.editor.appendChild(block);
  }

  scrollToBottom();
}

function showEmptyState() {
  dom.editor.innerHTML = `
    <div class="editor-empty-state">
      <h2>Start Writing</h2>
      <p>Click <strong>User Msg</strong> to add your first message, or just start typing and hit <strong>Generate</strong> to begin collaborating with your AI writing partner.</p>
      <button id="btn-quick-start" class="toolbar-btn accent" style="margin-top: 8px; padding: 10px 24px; font-size: 14px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        New User Message
      </button>
    </div>
  `;
  const quickBtn = $('#btn-quick-start');
  if (quickBtn) quickBtn.addEventListener('click', addUserMessage);
}

function createMessageBlock(msg, index) {
  const block = document.createElement('div');
  block.className = `message-block ${msg.role}`;
  block.dataset.index = index;

  const content = state.isRawEditMode ? createEditArea(msg, index) : createRenderedContent(msg);

  block.innerHTML = `
    <div class="message-header">
      <span class="message-role">${msg.role}</span>
      <div class="message-actions">
        <button class="msg-action-btn edit-btn" title="Edit" data-index="${index}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="msg-action-btn delete" title="Delete message" data-index="${index}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3,6 5,6 21,6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
    <div class="message-content-wrapper"></div>
  `;

  block.querySelector('.message-content-wrapper').appendChild(content);

  // Wire action buttons
  block.querySelector('.edit-btn').addEventListener('click', () => toggleEditMessage(index));
  block.querySelector('.delete').addEventListener('click', () => deleteMessage(index));

  return block;
}

function createRenderedContent(msg) {
  const div = document.createElement('div');
  div.className = 'message-content';
  div.innerHTML = marked.parse(msg.content || ' ');
  
  if (state.findQuery && !state.isRawEditMode) {
    highlightTextInElement(div, state.findQuery);
  }
  
  return div;
}

function highlightTextInElement(element, query) {
  if (!query) return;
  const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${safeQuery})`, 'gi');
  
  const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  const nodes = [];
  let node;
  while(node = walk.nextNode()) {
    if (node.parentNode.nodeName === 'CODE' || node.parentNode.nodeName === 'PRE') {
      continue;
    }
    if (regex.test(node.nodeValue)) {
      nodes.push(node);
    }
    regex.lastIndex = 0;
  }
  
  nodes.forEach(n => {
    const temp = document.createElement('span');
    const escaped = escapeHtml(n.nodeValue);
    temp.innerHTML = escaped.replace(regex, `<mark class="find-highlight">$1</mark>`);
    
    while (temp.firstChild) {
      n.parentNode.insertBefore(temp.firstChild, n);
    }
    n.parentNode.removeChild(n);
  });
}

function createEditArea(msg, index) {
  const textarea = document.createElement('textarea');
  textarea.className = 'message-edit-area';
  textarea.value = msg.content;
  textarea.dataset.index = index;

  // Auto-resize
  const autoResize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  };
  textarea.addEventListener('input', () => {
    autoResize();
    state.messages[index].content = textarea.value;
    debouncedSave();
    updateWordCount();
  });

  // Initial sizing after mount
  requestAnimationFrame(autoResize);
  return textarea;
}

function toggleEditMessage(index) {
  const block = dom.editor.querySelector(`.message-block[data-index="${index}"]`);
  if (!block) return;

  const wrapper = block.querySelector('.message-content-wrapper');
  const isEditing = wrapper.querySelector('.message-edit-area');

  if (isEditing) {
    // Switch back to rendered mode
    wrapper.innerHTML = '';
    wrapper.appendChild(createRenderedContent(state.messages[index]));
  } else {
    // Switch to edit mode
    wrapper.innerHTML = '';
    wrapper.appendChild(createEditArea(state.messages[index], index));
  }
}

function deleteMessage(index) {
  state.messages.splice(index, 1);
  renderEditor();
  debouncedSave();
  updateWordCount();
}

function addUserMessage() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.messages.push({ role: 'user', content: '', id });
  renderEditor();

  // Focus the new message's edit area
  const lastBlock = dom.editor.querySelector(`.message-block:last-child`);
  if (lastBlock) {
    const wrapper = lastBlock.querySelector('.message-content-wrapper');
    wrapper.innerHTML = '';
    wrapper.appendChild(createEditArea(state.messages[state.messages.length - 1], state.messages.length - 1));
    const textarea = wrapper.querySelector('.message-edit-area');
    if (textarea) textarea.focus();
  }

  scrollToBottom();
  debouncedSave();
  updateContextGauge();
}

// ---- Generation ----
async function generate(continueMode = false) {
  if (state.isGenerating) return;
  if (state.messages.length === 0) return;

  let msgIndex;

  if (continueMode) {
    // Continue: stream into the existing last assistant message
    msgIndex = state.messages.length - 1;
    // Snapshot the content before this generation segment
    state.lastGenSnapshot = {
      msgIndex,
      contentBefore: state.messages[msgIndex].content,
      wasNewMessage: false,
    };
  } else {
    // New generation: add an empty assistant message
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.messages.push({ role: 'assistant', content: '', id });
    msgIndex = state.messages.length - 1;
    // Snapshot: content was empty, this was a new message
    state.lastGenSnapshot = {
      msgIndex,
      contentBefore: '',
      wasNewMessage: true,
    };
    renderEditor();
  }

  // Build messages array for API
  const apiMessages = [];

  const systemPrompt = getSystemPrompt();
  if (systemPrompt) {
    apiMessages.push({ role: 'system', content: systemPrompt });
  }

  // Clone messages for API to insert author note without modifying state
  const tempMessages = [...state.messages];
  
  // Inject Author's Note if enabled
  const authorEnabled = $('#setting-author-enabled').checked;
  const authorNote = $('#setting-author-note').value.trim();
  const authorDepth = parseInt($('#setting-author-depth').value) || 0;
  
  if (authorEnabled && authorNote) {
    // Find injection index (from end of history, ignoring current streaming assistant message)
    // For a new generation, the last message is the empty assistant message.
    let injectionIndex = tempMessages.length - 1 - authorDepth;
    if (injectionIndex < 0) injectionIndex = 0;
    
    // Insert author note as a system message
    tempMessages.splice(injectionIndex, 0, { role: 'system', content: `[Author's Note: ${authorNote}]` });
  }

  for (const msg of tempMessages) {
    if (msg.content) { // don't send empty continuing message yet
      apiMessages.push({ role: msg.role, content: msg.content });
    }
  }

  // UI state
  state.isGenerating = true;
  state.streamingContent = state.messages[msgIndex].content;
  updateGeneratingUI(true);

  const params = getCurrentSamplingParams();

  await llmClient.stream(apiMessages, params, {
    onToken: (token) => {
      state.streamingContent += token;
      state.messages[msgIndex].content = state.streamingContent;

      // Update the message block in the editor
      const block = dom.editor.querySelector(`.message-block[data-index="${msgIndex}"]`);
      if (block) {
        const wrapper = block.querySelector('.message-content-wrapper');
        let contentDiv = wrapper.querySelector('.message-content');
        if (!contentDiv) {
          contentDiv = document.createElement('div');
          contentDiv.className = 'message-content';
          wrapper.innerHTML = '';
          wrapper.appendChild(contentDiv);
        }

        // Run slop detection
        const slopResult = slopDetector.analyze(state.streamingContent);

        if (slopResult.highlightRanges && slopResult.highlightRanges.length > 0) {
          // During streaming with slop: render as plain text with highlight spans
          const highlighted = slopDetector.renderWithHighlights(state.streamingContent, slopResult.highlightRanges);
          if (highlighted) {
            contentDiv.innerHTML = highlighted + '<span class="streaming-cursor"></span>';
          } else {
            contentDiv.innerHTML = marked.parse(state.streamingContent) + '<span class="streaming-cursor"></span>';
          }
        } else {
          // No slop: render with markdown
          contentDiv.innerHTML = marked.parse(state.streamingContent) + '<span class="streaming-cursor"></span>';
        }

        // Auto-stop on slop
        if (slopResult.slopDetected) {
          llmClient.stop();
          if (slopDetector.autoRollback) {
            rollbackSlop(msgIndex, slopResult.repeatedPhrase);
          }
        }
      }

      scrollToBottom();
    },

    onDone: (stats) => {
      state.isGenerating = false;
      state.streamingContent = '';
      updateGeneratingUI(false);
      updateStats(stats);

      // Remove streaming cursor and re-render with proper markdown
      const block = dom.editor.querySelector(`.message-block[data-index="${msgIndex}"]`);
      if (block) {
        const wrapper = block.querySelector('.message-content-wrapper');
        wrapper.innerHTML = '';
        wrapper.appendChild(createRenderedContent(state.messages[msgIndex]));
      }

      debouncedSave();
      updateWordCount();
      updateContextGauge();
    },

    onError: (err) => {
      state.isGenerating = false;
      updateGeneratingUI(false);
      console.error('LLM Error:', err);

      // Show error in a temporary notification
      showNotification(`Error: ${err.message}`, 'error');
    },
  });
}

function rollbackSlop(msgIndex, repeatedPhrase) {
  const content = state.messages[msgIndex].content;

  if (slopDetector.paragraphRollback) {
    // Roll back to the start of the current paragraph
    const lastParagraphBreak = content.lastIndexOf('\n\n');
    if (lastParagraphBreak > 0) {
      state.messages[msgIndex].content = content.slice(0, lastParagraphBreak);
    }
  } else {
    // Roll back the repeated portion
    const lastIdx = content.lastIndexOf(repeatedPhrase);
    if (lastIdx > 0) {
      state.messages[msgIndex].content = content.slice(0, lastIdx).trimEnd();
    }
  }
}

function stopGeneration() {
  if (state.isGenerating) {
    llmClient.stop();
  }
}

function undoLastGeneration() {
  if (!state.lastGenSnapshot) {
    // Fallback: remove the last assistant message entirely
    if (state.messages.length > 0 && state.messages[state.messages.length - 1].role === 'assistant') {
      state.messages.pop();
      renderEditor();
      debouncedSave();
      updateWordCount();
    }
    return;
  }

  const snap = state.lastGenSnapshot;

  if (snap.wasNewMessage && snap.contentBefore === '') {
    // The last generation created a brand new assistant message — remove it entirely
    if (snap.msgIndex < state.messages.length) {
      state.messages.splice(snap.msgIndex, 1);
    }
  } else {
    // The last generation was a continuation — restore the content to what it was before
    if (snap.msgIndex < state.messages.length) {
      state.messages[snap.msgIndex].content = snap.contentBefore;
    }
  }

  state.lastGenSnapshot = null;
  renderEditor();
  debouncedSave();
  updateWordCount();
  updateContextGauge();
}

function retryLastGeneration() {
  if (state.isGenerating) return;
  if (!state.lastGenSnapshot && state.messages.length > 0 && state.messages[state.messages.length - 1].role === 'assistant') {
    // No snapshot (e.g. page reload) — remove last assistant message and regenerate fresh
    state.messages.pop();
    renderEditor();
    setTimeout(() => generate(), 50);
    return;
  }
  if (!state.lastGenSnapshot) return;

  const snap = state.lastGenSnapshot;

  if (snap.wasNewMessage && snap.contentBefore === '') {
    // Last gen created a new message — remove it, then generate fresh
    if (snap.msgIndex < state.messages.length) {
      state.messages.splice(snap.msgIndex, 1);
    }
    state.lastGenSnapshot = null;
    renderEditor();
    setTimeout(() => generate(), 50);
  } else {
    // Last gen was a continuation — restore content, then continue from that point
    if (snap.msgIndex < state.messages.length) {
      state.messages[snap.msgIndex].content = snap.contentBefore;
    }
    state.lastGenSnapshot = null;
    renderEditor();
    setTimeout(() => generate(true), 50);
  }
}

function continueGeneration() {
  if (state.messages.length === 0) return;
  const lastMsg = state.messages[state.messages.length - 1];
  if (lastMsg.role !== 'assistant') return;
  generate(true);
}

// ---- UI Helpers ----
function updateGeneratingUI(generating) {
  const btnSend = $('#btn-send');
  const btnStop = $('#btn-stop');
  const btnContinue = $('#btn-continue');
  const btnUndo = $('#btn-undo-gen');
  const btnRetry = $('#btn-retry');

  if (generating) {
    btnSend.classList.add('hidden');
    btnStop.classList.remove('hidden');
    btnContinue.classList.add('hidden');
    btnUndo.classList.add('hidden');
    btnRetry.classList.add('hidden');
  } else {
    btnSend.classList.remove('hidden');
    btnStop.classList.add('hidden');
    btnContinue.classList.remove('hidden');
    btnUndo.classList.remove('hidden');
    btnRetry.classList.remove('hidden');
  }
}

function updateStats(stats) {
  dom.statusModel.textContent = stats.model || 'Unknown';
  dom.statusTokensSec.textContent = `${stats.tokensPerSec.toFixed(1)} t/s`;
  dom.statusTtft.textContent = `TTFT: ${(stats.ttftMs / 1000).toFixed(2)}s`;
  dom.statusGenInfo.textContent = `${stats.tokensGenerated} tokens in ${(stats.totalTimeMs / 1000).toFixed(1)}s`;
}

function updateWordCount() {
  const allText = state.messages.map(m => m.content).join(' ');
  const words = allText.trim() ? allText.trim().split(/\s+/).length : 0;
  const chars = allText.length;
  dom.statusWords.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  dom.statusChars.textContent = `${chars} char${chars !== 1 ? 's' : ''}`;
}

function estimateTokens(text) {
  // Rough estimation: 1 token ≈ 4 characters
  return Math.ceil(text.length / 4);
}

function updateContextGauge() {
  let totalText = getSystemPrompt();
  totalText += state.messages.map(m => m.content).join('\n');
  const contextTokens = estimateTokens(totalText);
  const maxTokens = parseInt($('#setting-context-size').value) || 8192;
  
  let percentage = (contextTokens / maxTokens) * 100;
  if (percentage > 100) percentage = 100;
  
  dom.contextGaugeFill.style.width = `${percentage}%`;
  dom.contextGaugeLabel.textContent = `Context: ${contextTokens} / ${maxTokens} tok`;
  
  dom.contextGaugeFill.classList.remove('warning', 'danger');
  if (percentage >= 90) {
    dom.contextGaugeFill.classList.add('danger');
  } else if (percentage >= 75) {
    dom.contextGaugeFill.classList.add('warning');
  }
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.editor.scrollTop = dom.editor.scrollHeight;
  });
}

function showNotification(message, type = 'info') {
  const notif = document.createElement('div');
  notif.style.cssText = `
    position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);
    padding: 10px 20px; border-radius: var(--radius-md);
    background: ${type === 'error' ? 'var(--accent-red)' : 'var(--accent-primary)'};
    color: white; font-size: 13px; z-index: 300;
    box-shadow: var(--shadow-md); animation: fadeIn 0.2s ease;
    font-family: var(--font-body);
  `;
  notif.textContent = message;
  document.body.appendChild(notif);
  setTimeout(() => {
    notif.style.opacity = '0';
    notif.style.transition = 'opacity 0.3s ease';
    setTimeout(() => notif.remove(), 300);
  }, 4000);
}

// ---- Auto-save ----
function debouncedSave() {
  dom.statusSave.textContent = '● Unsaved';
  dom.statusSave.style.color = 'var(--accent-orange)';

  if (state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
  state.autoSaveTimer = setTimeout(async () => {
    if (state.currentSessionId) {
      await updateSession(state.currentSessionId, { messages: state.messages });
      dom.statusSave.textContent = '✓ Saved';
      dom.statusSave.style.color = '';
    }
  }, 800);
}

// ---- Event Bindings ----
function bindEvents() {
  // Toolbar buttons
  $('#btn-new-user-msg').addEventListener('click', addUserMessage);
  $('#btn-send').addEventListener('click', () => generate());
  $('#btn-stop').addEventListener('click', stopGeneration);
  $('#btn-continue').addEventListener('click', continueGeneration);
  $('#btn-undo-gen').addEventListener('click', undoLastGeneration);
  $('#btn-retry').addEventListener('click', retryLastGeneration);

  // Raw edit mode toggle
  $('#btn-edit-mode').addEventListener('click', () => {
    state.isRawEditMode = !state.isRawEditMode;
    $('#btn-edit-mode').classList.toggle('active-toggle', state.isRawEditMode);
    renderEditor();
  });

  // Zen Mode
  $('#btn-zen').addEventListener('click', () => {
    document.body.classList.toggle('zen-mode');
  });

  // Find toggle
  $('#btn-find').addEventListener('click', () => {
    dom.findBar.classList.toggle('hidden');
    if (!dom.findBar.classList.contains('hidden')) {
      $('#find-input').focus();
    } else {
      state.findQuery = '';
      $('#find-input').value = '';
      renderEditor();
    }
  });

  $('#btn-find-close').addEventListener('click', () => {
    dom.findBar.classList.add('hidden');
    state.findQuery = '';
    $('#find-input').value = '';
    renderEditor();
  });
  
  $('#find-input').addEventListener('input', (e) => {
    state.findQuery = e.target.value;
    renderEditor(); // This highlights the text in view
    
    // Update match count
    let totalMatches = 0;
    if (state.findQuery) {
      const safeQuery = state.findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safeQuery, 'gi');
      for (const msg of state.messages) {
        if (!msg.content) continue;
        const matches = msg.content.match(regex);
        if (matches) totalMatches += matches.length;
      }
    }
    $('#find-count').textContent = totalMatches > 0 ? `${totalMatches} match${totalMatches>1?'es':''}` : '0/0';
  });

  // Find actions (basic in-message string replacement)
  const performFindReplace = (replaceAll = false) => {
    const findText = $('#find-input').value;
    const repText = $('#replace-input').value;
    if (!findText) return;

    let totalMatches = 0;
    let replacedCount = 0;
    
    // We only replace if not replacing all, we replace the first occurrence
    for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i];
        if (!msg.content) continue;
        
        let count = msg.content.split(findText).length - 1;
        totalMatches += count;
        
        if (count > 0) {
            if (replaceAll) {
                msg.content = msg.content.split(findText).join(repText);
                replacedCount += count;
            } else if (replacedCount === 0) {
                msg.content = msg.content.replace(findText, repText);
                replacedCount = 1;
            }
        }
    }
    
    $('#find-count').textContent = `${replacedCount} replaced`;
    if (replacedCount > 0) {
        renderEditor();
        debouncedSave();
        updateWordCount();
        updateContextGauge();
    }
  };

  $('#btn-find-next').addEventListener('click', () => performFindReplace(false));
  $('#btn-find-prev').addEventListener('click', () => performFindReplace(false)); // Just aliases for now
  $('#btn-replace').addEventListener('click', () => performFindReplace(false));
  $('#btn-replace-all').addEventListener('click', () => performFindReplace(true));

  // Theme toggle
  $('#btn-theme-toggle').addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    await setSetting('theme', next);
  });

  // Panel toggles
  $('#btn-toggle-sessions').addEventListener('click', async () => {
    dom.panelSessions.classList.toggle('collapsed');
    await setSetting('sessionsCollapsed', dom.panelSessions.classList.contains('collapsed'));
  });
  $('#btn-toggle-settings').addEventListener('click', async () => {
    dom.panelSettings.classList.toggle('collapsed');
    await setSetting('settingsCollapsed', dom.panelSettings.classList.contains('collapsed'));
  });

  // New session
  $('#btn-new-session').addEventListener('click', async () => {
    const session = await createSession('New Session');
    await loadSessionList();
    await loadSession(session.id);
  });

  // Session search
  $('#session-search').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    $$('.session-item').forEach(item => {
      const name = item.querySelector('.session-name').textContent.toLowerCase();
      item.style.display = name.includes(query) ? '' : 'none';
    });
  });

  // Export Session
  $('#btn-export-session').addEventListener('click', async () => {
    if (!state.currentSessionId) return;
    const session = await getSession(state.currentSessionId);
    if (!session) return;
    
    const dataStr = JSON.stringify(session, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `cwrite_session_${session.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
  });

  // Import Session
  $('#btn-import-session').addEventListener('click', () => {
    $('#import-session-file').click();
  });

  $('#import-session-file').addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (!data.name || !Array.isArray(data.messages)) throw new Error('Invalid format');
        
        const newSession = await createSession(data.name);
        await updateSession(newSession.id, { messages: data.messages });
        
        await loadSessionList();
        await loadSession(newSession.id);
        showNotification(`Session imported!`);
      } catch (err) {
        showNotification('Invalid session JSON.', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // Reset
  });

  // Preset selector
  dom.presetSelect.addEventListener('change', (e) => {
    applyPreset(parseInt(e.target.value));
  });

  // Preset management buttons
  $('#btn-preset-save').addEventListener('click', async () => {
    if (!state.currentPresetId) return;
    const preset = await getPreset(state.currentPresetId);
    if (preset && preset.isBuiltIn) {
      showNotification('Cannot overwrite built-in presets. Use "Save As New" instead.', 'error');
      return;
    }
    await savePreset(state.currentPresetId, {
      systemPrompt: getSystemPrompt(),
      settings: getCurrentSamplingParams(),
    });
    showNotification('Preset saved!');
  });

  $('#btn-preset-save-as').addEventListener('click', async () => {
    const name = prompt('New preset name:');
    if (!name || !name.trim()) return;
    const preset = await createPreset({
      name: name.trim(),
      systemPrompt: getSystemPrompt(),
      settings: getCurrentSamplingParams(),
    });
    state.currentPresetId = preset.id;
    await loadPresetList();
    showNotification(`Preset "${name.trim()}" created!`);
  });

  $('#btn-preset-delete').addEventListener('click', async () => {
    if (!state.currentPresetId) return;
    const preset = await getPreset(state.currentPresetId);
    if (preset?.isBuiltIn) {
      showNotification('Cannot delete built-in presets.', 'error');
      return;
    }
    if (confirm(`Delete preset "${preset?.name}"?`)) {
      await deletePreset(state.currentPresetId);
      state.currentPresetId = null;
      await loadPresetList();
      showNotification('Preset deleted.');
    }
  });

  $('#btn-preset-export').addEventListener('click', async () => {
    if (!state.currentPresetId) return;
    const json = await exportPreset(state.currentPresetId);
    if (json) {
      navigator.clipboard.writeText(json).then(() => {
        showNotification('Preset copied to clipboard!');
      });
    }
  });

  $('#btn-preset-import').addEventListener('click', async () => {
    const json = prompt('Paste preset JSON:');
    if (!json) return;
    try {
      const preset = await importPreset(json);
      await loadPresetList();
      await applyPreset(preset.id);
      showNotification(`Preset "${preset.name}" imported!`);
    } catch (e) {
      showNotification('Invalid preset JSON.', 'error');
    }
  });

  // Settings - Connection (auto-save on change)
  const connectionInputs = ['#setting-endpoint', '#setting-api-key', '#setting-model'];
  for (const sel of connectionInputs) {
    $(sel).addEventListener('change', async () => {
      const endpoint = $('#setting-endpoint').value;
      const apiKey = $('#setting-api-key').value;
      const model = $('#setting-model').value;
      llmClient.configure({ endpoint, apiKey, model });
      await setSetting('endpoint', endpoint);
      await setSetting('apiKey', apiKey);
      await setSetting('model', model);
      dom.statusModel.textContent = model || 'No model';
    });
  }

  // Settings - Sampling sliders (update output labels)
  const sliders = [
    { id: 'setting-temperature', output: 'val-temperature' },
    { id: 'setting-top-p', output: 'val-top-p' },
    { id: 'setting-top-k', output: 'val-top-k' },
    { id: 'setting-min-p', output: 'val-min-p' },
    { id: 'setting-repeat-penalty', output: 'val-repeat-penalty' },
    { id: 'setting-font-size', output: 'val-font-size' },
    { id: 'setting-slop-threshold', output: 'val-slop-threshold' },
  ];
  for (const { id, output } of sliders) {
    $(`#${id}`).addEventListener('input', (e) => {
      $(`#${output}`).textContent = e.target.value;
    });
  }

  // Font size persistence
  $('#setting-font-size').addEventListener('change', async (e) => {
    const size = e.target.value;
    document.documentElement.style.setProperty('--font-size-base', `${size}px`);
    await setSetting('fontSize', parseInt(size));
  });

  // Color pickers
  $('#setting-user-color').addEventListener('input', async (e) => {
    document.documentElement.style.setProperty('--bg-user-msg', e.target.value);
    await setSetting('userMsgColor', e.target.value);
  });
  $('#setting-assistant-color').addEventListener('input', async (e) => {
    document.documentElement.style.setProperty('--bg-assistant-msg', e.target.value);
    await setSetting('assistantMsgColor', e.target.value);
  });

  // Slop settings
  $('#setting-slop-enabled').addEventListener('change', async (e) => {
    slopDetector.configure({ enabled: e.target.checked });
    await setSetting('slopEnabled', e.target.checked);
  });
  $('#setting-slop-threshold').addEventListener('change', async (e) => {
    slopDetector.configure({ threshold: parseInt(e.target.value) });
    await setSetting('slopThreshold', parseInt(e.target.value));
  });
  $('#setting-slop-rollback').addEventListener('change', async (e) => {
    slopDetector.configure({ autoRollback: e.target.checked });
    await setSetting('slopRollback', e.target.checked);
  });
  $('#setting-slop-paragraph').addEventListener('change', async (e) => {
    slopDetector.configure({ paragraphRollback: e.target.checked });
    await setSetting('slopParagraph', e.target.checked);
  });

  // Settings section collapses
  $$('.settings-section-title').forEach(title => {
    title.addEventListener('click', () => {
      const targetId = title.dataset.collapse;
      const body = $(`#section-${targetId}`);
      title.classList.toggle('collapsed');
      body.classList.toggle('collapsed');
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+Enter = Generate
    if (e.ctrlKey && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (state.isGenerating) return;
      generate();
    }
    // Ctrl+Shift+Enter = Continue
    if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      continueGeneration();
    }
    // Escape = Stop
    if (e.key === 'Escape') {
      stopGeneration();
    }
    // Ctrl+Shift+N = New user message
    if (e.ctrlKey && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
      e.preventDefault();
      addUserMessage();
    }
    // Ctrl+/ = Toggle raw edit mode
    if (e.ctrlKey && e.key === '/') {
      e.preventDefault();
      state.isRawEditMode = !state.isRawEditMode;
      $('#btn-edit-mode').classList.toggle('active-toggle', state.isRawEditMode);
      renderEditor();
    }
    // Ctrl+F = Find
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      dom.findBar.classList.toggle('hidden');
      if (!dom.findBar.classList.contains('hidden')) {
        $('#find-input').focus();
      } else {
        state.findQuery = '';
        $('#find-input').value = '';
        renderEditor();
      }
    }
    // F11 = Zen mode (allow default full screen to happen, just toggle our class)
    if (e.key === 'F11') {
      document.body.classList.toggle('zen-mode');
    }
  });

  // Prevent accidental tab close
  window.addEventListener('beforeunload', (e) => {
    if (state.messages.length > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ---- Helpers ----
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---- Init on load ----
document.addEventListener('DOMContentLoaded', init);
