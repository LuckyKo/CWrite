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
const thinkExtension = {
  name: 'think',
  level: 'block',
  start(src) { return src.match(/<think/)?.index; },
  tokenizer(src, tokens) {
    const rule = /^<think>([\s\S]*?)(?:<\/think>|$)/;
    const match = rule.exec(src);
    if (match) {
      const token = {
        type: 'think',
        raw: match[0],
        text: match[1].trim(),
        tokens: []
      };
      this.lexer.blockTokens(token.text, token.tokens);
      return token;
    }
  },
  renderer(token) {
    return `<think>${this.parser.parse(token.tokens)}</think>`;
  }
};

marked.use({ 
  extensions: [thinkExtension],
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
  inlineGenState: null,   // { prefix, suffix } for mid-message insertion
  lastGenSnapshot: null,  // { msgIndex, contentBefore, wasNewMessage, inlineGenState? }
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
  const slopMinLen = await getSetting('slopMinLen', 3);
  const slopOccurrence = await getSetting('slopOccurrence', 2);
  const slopThreshold = await getSetting('slopThreshold', 3);
  const slopRollback = await getSetting('slopRollback', false);
  const slopParagraph = await getSetting('slopParagraph', false);
  
  $('#setting-slop-enabled').checked = slopEnabled;
  $('#setting-slop-min-len').value = slopMinLen;
  $('#val-slop-min-len').textContent = slopMinLen;
  $('#setting-slop-occurrence').value = slopOccurrence;
  $('#val-slop-occurrence').textContent = slopOccurrence;
  $('#setting-slop-threshold').value = slopThreshold;
  $('#val-slop-threshold').textContent = slopThreshold;
  $('#setting-slop-rollback').checked = slopRollback;
  $('#setting-slop-paragraph').checked = slopParagraph;
  
  slopDetector.configure({ 
    enabled: slopEnabled, 
    minSequenceLength: slopMinLen,
    occurrenceThreshold: slopOccurrence,
    threshold: slopThreshold, 
    autoRollback: slopRollback, 
    paragraphRollback: slopParagraph 
  });

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
  // Migration: Ensure all messages have 'versions' and 'activeVersion'
  state.messages = (session.messages || []).map(msg => {
    if (msg.versions === undefined) {
      return {
        ...msg,
        versions: [msg.content || ''],
        activeVersion: 0
      };
    }
    return msg;
  });
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

  const vCount = msg.versions.length;
  const vIndex = msg.activeVersion + 1;

  block.innerHTML = `
    <div class="message-header">
      <div class="message-info">
        <span class="message-role">${msg.role}</span>
        ${vCount > 1 ? `
          <div class="swipe-controls">
            <button class="swipe-btn prev" title="Previous version" ${msg.activeVersion === 0 ? 'disabled' : ''}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <span class="version-label">${vIndex} / ${vCount}</span>
            <button class="swipe-btn next" title="Next version" ${msg.activeVersion === vCount - 1 ? 'disabled' : ''}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        ` : ''}
      </div>
      <div class="message-actions">
        ${msg.role === 'assistant' ? `
          <button class="msg-action-btn new-swipe" title="New swipe (alt version)" data-index="${index}">
             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
        ` : ''}
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
  
  if (vCount > 1) {
    block.querySelector('.swipe-btn.prev')?.addEventListener('click', () => switchVersion(index, -1));
    block.querySelector('.swipe-btn.next')?.addEventListener('click', () => switchVersion(index, 1));
  }
  
  if (msg.role === 'assistant') {
    block.querySelector('.new-swipe')?.addEventListener('click', () => generateNewSwipe(index));
  }

  // Double click to edit word and jump cursor
  block.addEventListener('dblclick', (e) => {
    if (state.isRawEditMode) return;
    
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    
    let selectedText = sel.toString().trim();
    if (!selectedText) return;
    
    // Ignore clicks on header/buttons
    if (e.target.closest('.message-header')) return;
    
    const contentDiv = block.querySelector('.message-content');
    if (!contentDiv) return;
    
    const range = sel.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(contentDiv);
    preCaretRange.setEnd(range.startContainer, range.startOffset);
    const renderedOffset = preCaretRange.toString().length;
    const renderedLength = contentDiv.textContent.length;
    
    const proportion = renderedLength > 0 ? renderedOffset / renderedLength : 0;
    
    toggleEditMessage(index);
    const textarea = block.querySelector('.message-edit-area');
    if (!textarea) return;
    
    const rawContent = state.messages[index].versions[state.messages[index].activeVersion];
    const targetRawOffset = proportion * rawContent.length;
    
    let bestIdx = -1;
    let minDiff = Infinity;
    const safeText = selectedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    
    // First try exact word boundary match
    let regex = new RegExp(`\\b${safeText}\\b`, 'gi'); 
    let wordMatchFound = false;
    let match;
    while ((match = regex.exec(rawContent)) !== null) {
        wordMatchFound = true;
        const diff = Math.abs(match.index - targetRawOffset);
        if (diff < minDiff) {
            minDiff = diff;
            bestIdx = match.index;
        }
    }
    
    // Fallback if boundary match fails
    if (!wordMatchFound) {
      regex = new RegExp(safeText, 'gi');
      while ((match = regex.exec(rawContent)) !== null) {
          const diff = Math.abs(match.index - targetRawOffset);
          if (diff < minDiff) {
              minDiff = diff;
              bestIdx = match.index;
          }
      }
    }
    
    if (bestIdx !== -1) {
        // Sync resize to get true height for math without breaking DOM flow
        const scrollTop = dom.editor.scrollTop;
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
        if (dom.editor.scrollTop !== scrollTop) dom.editor.scrollTop = scrollTop;

        textarea.focus();
        textarea.setSelectionRange(bestIdx, bestIdx + selectedText.length);

        // Estimate vertical position of the caret and center it within the editor scroll view
        const caretY = textarea.getBoundingClientRect().top + dom.editor.scrollTop - dom.editor.getBoundingClientRect().top + (proportion * textarea.scrollHeight);
        dom.editor.scrollTo({
            top: caretY - (dom.editor.clientHeight / 2),
            behavior: 'smooth'
        });
    } else {
        textarea.focus();
    }
  });

  return block;
}

function createRenderedContent(msg) {
  const div = document.createElement('div');
  div.className = 'message-content';
  div.innerHTML = marked.parse(msg.versions[msg.activeVersion] || ' ');
  
  if (state.findQuery && !state.isRawEditMode) {
    highlightTextInElement(div, state.findQuery);
  }

  // Persistent Slop Highlights in Rendered View (Global & Precise)
  if (!state.isRawEditMode) {
    applyGlobalSlopHighlights(div);
  }
  
  return div;
}

function applyGlobalSlopHighlights(element) {
  const fullText = element.textContent;
  const highlights = slopDetector.findSlop(fullText);
  if (highlights.length === 0) return;

  const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null, false);
  let currentOffset = 0;
  const nodesToProcess = [];
  let node;
  
  while (node = walk.nextNode()) {
    const parent = node.parentNode;
    if (parent.nodeName === 'CODE' || parent.nodeName === 'PRE' || parent.closest('pre') || parent.closest('code')) {
      currentOffset += node.nodeValue.length;
      continue;
    }
    nodesToProcess.push({
      node,
      start: currentOffset,
      end: currentOffset + node.nodeValue.length
    });
    currentOffset += node.nodeValue.length;
  }

  // Iterate backwards to replace nodes safely
  for (let i = nodesToProcess.length - 1; i >= 0; i--) {
    const { node, start, end } = nodesToProcess[i];
    const nodeHighlights = highlights.filter(h => h.start < end && h.end > start);
    
    if (nodeHighlights.length > 0) {
      const parent = node.parentNode;
      const fragments = document.createDocumentFragment();
      let lastIdx = 0;
      const text = node.nodeValue;
      
      // Sort highlights for this specific node
      const sorted = nodeHighlights.sort((a,b) => a.start - b.start);
      
      sorted.forEach(h => {
        const localStart = Math.max(0, h.start - start);
        const localEnd = Math.min(text.length, h.end - start);
        
        if (localStart > lastIdx) {
          fragments.appendChild(document.createTextNode(text.slice(lastIdx, localStart)));
        }
        
        const mark = document.createElement('mark');
        mark.className = h.severity; // slop.js now returns "level-N", but we need "slop-level-N"
        // Wait, slop.js returns "level-N". Our CSS uses ".slop-level-N".
        mark.classList.add('slop-highlight');
        mark.classList.add(h.severity.startsWith('level') ? `slop-${h.severity}` : h.severity);
        mark.textContent = text.slice(localStart, localEnd);
        fragments.appendChild(mark);
        
        lastIdx = localEnd;
      });
      
      if (lastIdx < text.length) {
        fragments.appendChild(document.createTextNode(text.slice(lastIdx)));
      }
      
      parent.replaceChild(fragments, node);
    }
  }
}

function highlightTextInElement(element, query, className = 'find-highlight') {
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
    temp.innerHTML = escaped.replace(regex, `<mark class="${className}">$1</mark>`);
    
    while (temp.firstChild) {
      n.parentNode.insertBefore(temp.firstChild, n);
    }
    n.parentNode.removeChild(n);
  });
}

function createEditArea(msg, index) {
  const textarea = document.createElement('textarea');
  textarea.className = 'message-edit-area';
  textarea.value = msg.versions[msg.activeVersion];
  textarea.dataset.index = index;

  // Auto-resize with scroll preservation
  const autoResize = () => {
    const scrollTop = dom.editor.scrollTop;
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    if (dom.editor.scrollTop !== scrollTop) {
      dom.editor.scrollTop = scrollTop;
    }
  };
  textarea.addEventListener('input', () => {
    autoResize();
    state.messages[index].versions[state.messages[index].activeVersion] = textarea.value;
    debouncedSave();
    updateWordCount();
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      toggleEditMessage(index);
    }
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
  updateContextGauge();
}

function switchVersion(index, delta) {
  const msg = state.messages[index];
  const next = msg.activeVersion + delta;
  if (next >= 0 && next < msg.versions.length) {
    msg.activeVersion = next;
    renderEditor(); // Full re-render is simplest to keep everything in sync
    debouncedSave();
    updateWordCount();
  }
}

async function generateNewSwipe(index) {
  if (state.isGenerating) return;
  
  const msg = state.messages[index];
  // 1. Prepare for generation at this index
  // We'll add a new empty version and set it as active
  msg.versions.push('');
  msg.activeVersion = msg.versions.length - 1;
  
  // 2. Trigger generation (not continue mode)
  await generateInternal(index, false);
}

/**
 * Shared generation logic for both new messages and new swipes or continues.
 * @param {number} targetIndex - the index of the message to stream into
 * @param {boolean} continueMode - if true, appends to existing content
 */
async function generateInternal(targetIndex, continueMode = false) {
  let msgIndex = targetIndex;

  // Build messages array for API
  const apiMessages = [];

  const systemPrompt = getSystemPrompt();
  if (systemPrompt) {
    apiMessages.push({ role: 'system', content: systemPrompt });
  }

  // Only take messages UP TO targetIndex (excluding it if it's the one we're generating)
  // But wait, if it's a Swipe, we want everything BEFORE targetIndex as history.
  const tempMessages = state.messages.slice(0, targetIndex);
  
  // Inject Author's Note if enabled
  const authorEnabled = $('#setting-author-enabled').checked;
  const authorNote = $('#setting-author-note').value.trim();
  const authorDepth = parseInt($('#setting-author-depth').value) || 0;
  
  if (authorEnabled && authorNote) {
    let injectionIndex = tempMessages.length - authorDepth;
    if (injectionIndex < 0) injectionIndex = 0;
    tempMessages.splice(injectionIndex, 0, { role: 'system', content: `[Author's Note: ${authorNote}]` });
  }

  for (const msg of tempMessages) {
    const actContent = msg.versions[msg.activeVersion];
    if (actContent) {
      apiMessages.push({ role: msg.role, content: actContent });
    }
  }

  // If continue mode, also include the partial content of the TARGET message as history
  if (continueMode && !state.inlineGenState) {
    let actContent = state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion];
    if (actContent) {
      // Anti-truncation bug workaround for LM Studio / Llama.cpp:
      // Sending an exactly identical token count on a continue can cause the backend to dump the entire 45k KV cache.
      // NOTE: Appending a space forces the token state forward to bypass the cache dump, BUT it can heavily disrupt
      // the BPE tokenization boundary. Literal space tokens are out-of-distribution for the middle of a string
      // and cause infinite repetition loops. We accept the cache dump overhead to prevent hallucination/repetition.
      apiMessages.push({ role: 'assistant', content: actContent });
    }
  } else if (state.inlineGenState) {
    // Send only up to the cursor (prefix) for the target message
    apiMessages.push({ role: state.messages[msgIndex].role, content: state.inlineGenState.prefix });
  }

  if (apiMessages.length === 0) {
    // If we're generating a new message at the end, it might have been pushed already
    // If it's a swipe, we just cancel it.
    if (state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion] === '') {
       // but wait, if it's an assistant message we just created, we might want to keep it?
       // no, just error out.
    }
    showNotification("No content provided to generate a response from.", "error");
    return;
  }

  // UI state
  state.isGenerating = true;
  
  if (continueMode && !state.inlineGenState) {
    let actContent = state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion];
    state.streamingContent = actContent;
    // Do NOT clear content
  } else if (state.inlineGenState) {
    state.streamingContent = ''; 
    state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion] = state.inlineGenState.prefix + state.inlineGenState.suffix;
  } else {
    state.streamingContent = ''; // Start fresh for a new swipe
    state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion] = '';
  }
  
  updateGeneratingUI(true);
  if (!state.inlineGenState) {
    renderEditor(); // Update UI to show the empty/partial generating block
  }

  // If inline, sync the textarea so we can watch it type without re-rendering the DOM
  if (state.inlineGenState) {
    const editArea = dom.editor.querySelector(`.message-edit-area[data-index="${msgIndex}"]`);
    if (editArea) {
      editArea.value = state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion];
      editArea.focus();
      const caret = state.inlineGenState.prefix.length;
      editArea.setSelectionRange(caret, caret);
    }
  }

  const params = getCurrentSamplingParams();
  params.continueMode = continueMode;

  await llmClient.stream(apiMessages, params, {
    onToken: (token) => {
      state.streamingContent += token;
      
      const fullText = state.inlineGenState 
        ? state.inlineGenState.prefix + state.streamingContent + state.inlineGenState.suffix
        : state.streamingContent;
        
      state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion] = fullText;

      const block = dom.editor.querySelector(`.message-block[data-index="${msgIndex}"]`);
      if (block) {
        const wrapper = block.querySelector('.message-content-wrapper');

        const slopResult = slopDetector.analyze(state.streamingContent);
        
        if (state.inlineGenState) {
           const ta = wrapper.querySelector('.message-edit-area');
           if (ta) {
             ta.value = fullText;
             // Allow it to grow, but don't layout-thrash with 'auto' on every token
             if (ta.scrollHeight > ta.clientHeight) {
               ta.style.height = ta.scrollHeight + 'px';
             }
             
             // Keep caret at the injection point
             const caret = state.inlineGenState.prefix.length + state.streamingContent.length;
             ta.setSelectionRange(caret, caret);
           }
        } else {
          let contentDiv = wrapper.querySelector('.message-content');
          if (!contentDiv) {
            contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            wrapper.innerHTML = '';
            wrapper.appendChild(contentDiv);
          }
          
          if (slopResult.highlightRanges && slopResult.highlightRanges.length > 0) {
            const highlighted = slopDetector.renderWithHighlights(state.streamingContent, slopResult.highlightRanges);
            contentDiv.innerHTML = (highlighted || marked.parse(state.streamingContent)) + '<span class="streaming-cursor"></span>';
          } else {
            contentDiv.innerHTML = marked.parse(state.streamingContent) + '<span class="streaming-cursor"></span>';
          }
        }

        if (slopResult.slopDetected) {
          llmClient.stop();
          if (slopDetector.autoRollback) {
            rollbackSlop(msgIndex, slopResult.repeatedPhrase);
          }
        }
      }
      if (!state.inlineGenState) {
        if (msgIndex === state.messages.length - 1) {
          scrollToBottom();
        }
      }
    },

    onDone: (stats) => {
      state.isGenerating = false;
      const wasInline = !!state.inlineGenState;
      state.streamingContent = '';
      state.inlineGenState = null;
      updateGeneratingUI(false);
      updateStats(stats);

      if (!wasInline) {
        const block = dom.editor.querySelector(`.message-block[data-index="${msgIndex}"]`);
        if (block) {
          const wrapper = block.querySelector('.message-content-wrapper');
          wrapper.innerHTML = '';
          wrapper.appendChild(createRenderedContent(state.messages[msgIndex]));
        }
      } else {
        // Final clean height pass for the edit area after stream completes
        const block = dom.editor.querySelector(`.message-block[data-index="${msgIndex}"]`);
        if (block) {
          const ta = block.querySelector('.message-edit-area');
          if (ta) {
            ta.style.height = 'auto';
            ta.style.height = ta.scrollHeight + 'px';
            ta.focus();
            
            // Adjust editor scroll so the user's cursor doesn't jump off-screen
            const caretTop = ta.getBoundingClientRect().top + ta.selectionStart; // Rough approximation
            if (caretTop > window.innerHeight) {
               dom.editor.scrollTop += 150; 
            }
          }
        }
      }

      debouncedSave();
      updateWordCount();
      updateContextGauge();
    },

    onError: (err) => {
      state.isGenerating = false;
      updateGeneratingUI(false);
      console.error('LLM Error:', err);
      showNotification(`Error: ${err.message}`, 'error');
    },
  });
}

function addUserMessage() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.messages.push({ role: 'user', versions: [''], activeVersion: 0, id });
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
    msgIndex = state.messages.length - 1;
    state.lastGenSnapshot = {
      msgIndex,
      contentBefore: state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion],
      wasNewMessage: false,
    };
    await generateInternal(msgIndex, true);
  } else {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    state.messages.push({ role: 'assistant', versions: [''], activeVersion: 0, id });
    msgIndex = state.messages.length - 1;
    state.lastGenSnapshot = {
      msgIndex,
      contentBefore: '',
      wasNewMessage: true,
    };
    await generateInternal(msgIndex, false);
  }
}

function rollbackSlop(msgIndex, repeatedPhrase) {
  const content = state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion];

  if (slopDetector.paragraphRollback) {
    // Roll back to the start of the current paragraph
    const lastParagraphBreak = content.lastIndexOf('\n\n');
    if (lastParagraphBreak > 0) {
      state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion] = content.slice(0, lastParagraphBreak);
    }
  } else {
    // Roll back the repeated portion
    const lastIdx = content.lastIndexOf(repeatedPhrase);
    if (lastIdx > 0) {
      state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion] = content.slice(0, lastIdx).trimEnd();
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
      state.messages[snap.msgIndex].versions[state.messages[snap.msgIndex].activeVersion] = snap.contentBefore;
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
      state.messages[snap.msgIndex].versions[state.messages[snap.msgIndex].activeVersion] = snap.contentBefore;
    }
    const inlineState = snap.inlineGenState ? {...snap.inlineGenState} : null;
    state.lastGenSnapshot = null;
    
    // Actually apply the inlineState if it was an inline generation retry
    if (inlineState) state.inlineGenState = inlineState;
    
    renderEditor();
    setTimeout(() => {
        if (inlineState) generateInternal(snap.msgIndex, true);
        else generate(true);
    }, 50);
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
  const allText = state.messages.map(m => m.versions && m.versions[m.activeVersion] ? m.versions[m.activeVersion] : '').join(' ');
  const words = allText.trim() ? allText.trim().split(/\s+/).length : 0;
  const chars = allText.length;
  dom.statusWords.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  dom.statusChars.textContent = `${chars} char${chars !== 1 ? 's' : ''}`;
}

function estimateTokens(text) {
  // Prose estimation: modern tokenizer ratios (LLaMA/Mistral)
  // roughly average 1 token ≈ 4.86 characters (or ~1.18 tokens per word)
  // for standard English Creative Writing.
  return Math.ceil(text.length / 4.86);
}

function updateContextGauge() {
  let totalText = getSystemPrompt();
  totalText += state.messages.map(m => m.versions && m.versions[m.activeVersion] ? m.versions[m.activeVersion] : '').join('\n');
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
  
  // Use mousedown to intercept the active edit area before the button click steals focus
  $('#btn-continue').addEventListener('mousedown', (e) => {
    if (state.isGenerating) return;
    const activeEl = document.activeElement;
    
    if (activeEl && activeEl.classList.contains('message-edit-area')) {
      e.preventDefault(); // Keeps the textarea focused!
      const msgIndex = parseInt(activeEl.dataset.index);
      const text = activeEl.value;
      const start = activeEl.selectionStart;
      
      state.inlineGenState = {
        prefix: text.substring(0, start),
        suffix: text.substring(start)
      };
      
      state.lastGenSnapshot = {
        msgIndex,
        contentBefore: state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion],
        wasNewMessage: false,
        inlineGenState: { ...state.inlineGenState }
      };
      
      generateInternal(msgIndex, true);
    }
  });

  $('#btn-continue').addEventListener('click', (e) => {
    // If the mousedown handler intercepted this as an inline generation, early out.
    if (e.defaultPrevented || state.inlineGenState) return;
    continueGeneration();
  });
  
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
        const actContent = msg.versions ? msg.versions[msg.activeVersion] : '';
        if (!actContent) continue;
        const matches = actContent.match(regex);
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
        let actContent = msg.versions ? msg.versions[msg.activeVersion] : '';
        if (!actContent) continue;
        
        let count = actContent.split(findText).length - 1;
        totalMatches += count;
        
        if (count > 0) {
            if (replaceAll) {
                msg.versions[msg.activeVersion] = actContent.split(findText).join(repText);
                replacedCount += count;
            } else if (replacedCount === 0) {
                msg.versions[msg.activeVersion] = actContent.replace(findText, repText);
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
    { id: 'setting-slop-min-len', output: 'val-slop-min-len' },
    { id: 'setting-slop-occurrence', output: 'val-slop-occurrence' },
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

  // Context size persistence
  $('#setting-context-size').addEventListener('change', async (e) => {
    let size = parseInt(e.target.value);
    if (isNaN(size) || size < 1) size = 8192;
    await setSetting('contextSize', size);
    updateContextGauge();
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
    renderEditor();
  });
  $('#setting-slop-min-len').addEventListener('change', async (e) => {
    slopDetector.configure({ minSequenceLength: parseInt(e.target.value) });
    await setSetting('slopMinLen', parseInt(e.target.value));
    renderEditor();
  });
  $('#setting-slop-occurrence').addEventListener('change', async (e) => {
    slopDetector.configure({ occurrenceThreshold: parseInt(e.target.value) });
    await setSetting('slopOccurrence', parseInt(e.target.value));
    renderEditor();
  });
  $('#setting-slop-threshold').addEventListener('change', async (e) => {
    slopDetector.configure({ threshold: parseInt(e.target.value) });
    await setSetting('slopThreshold', parseInt(e.target.value));
    renderEditor();
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
      if (state.isGenerating) return;
      
      const activeEl = document.activeElement;
      if (activeEl && activeEl.classList.contains('message-edit-area')) {
        const msgIndex = parseInt(activeEl.dataset.index);
        const text = activeEl.value;
        const start = activeEl.selectionStart;
        
        state.inlineGenState = {
          prefix: text.substring(0, start),
          suffix: text.substring(start)
        };
        
        state.lastGenSnapshot = {
          msgIndex,
          contentBefore: state.messages[msgIndex].versions[state.messages[msgIndex].activeVersion],
          wasNewMessage: false,
          inlineGenState: { ...state.inlineGenState }
        };
        
        generateInternal(msgIndex, true);
      } else {
        continueGeneration();
      }
    }
    // Escape = Stop or Toggle modes
    if (e.key === 'Escape') {
      if (state.isGenerating) {
        stopGeneration();
      } else if (state.isRawEditMode) {
        state.isRawEditMode = false;
        $('#btn-edit-mode').classList.remove('active-toggle');
        renderEditor();
      } else if (!dom.findBar.classList.contains('hidden')) {
        dom.findBar.classList.add('hidden');
        state.findQuery = '';
        $('#find-input').value = '';
        renderEditor();
      }
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
