'use strict';

/**
 * 前端逻辑：拉取日记列表并渲染，支持实时搜索。
 *
 * 优化点：
 *  - 搜索文本由服务端预计算（searchText），输入时不重复解析 HTML
 *  - 输入防抖 + AbortController 取消过期请求，避免竞态与重复渲染
 *  - 只对标题做关键词高亮，正文保持 Markdown 渲染结果
 */

const DEBOUNCE_MS = 150;

const state = {
  diaries: [],
  keyword: '',
  controller: null,
  timer: null,
};

const els = {};

/** 初始化：绑定搜索、加载数据。导出以便在无浏览器环境下做单元测试 */
function boot() {
  els.list = document.getElementById('diary-list');
  els.status = document.getElementById('status');
  els.search = document.getElementById('search-input');
  if (!els.list) return;

  els.search?.addEventListener('input', onSearchInput);
  els.search?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      els.search.value = '';
      onSearchInput({ target: els.search });
    }
  });

  return loadDiaries();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { boot, state, normalizeDiary, highlight, formatTime, htmlToText, createCard };
}

/* ------------------------------------------------------------------ *
 * 数据
 * ------------------------------------------------------------------ */

async function loadDiaries() {
  state.controller?.abort();
  state.controller = new AbortController();

  setStatus('正在加载日记…');

  try {
    const res = await fetch('/api/diaries', {
      signal: state.controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    // 兼容旧的数组响应与新的 { diaries, ... } 结构
    const list = Array.isArray(payload) ? payload : payload?.diaries;
    if (!Array.isArray(list)) throw new Error('数据格式错误');

    state.diaries = list.map(normalizeDiary);
    state.keyword = '';
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.diaries = [];
    setStatus(`加载失败：${err.message}`, 'error');
    els.list.replaceChildren();
  } finally {
    state.controller = null;
  }
}

/** 统一字段类型，并兜底计算搜索文本 */
function normalizeDiary(raw = {}) {
  const title = String(raw.title ?? '未命名');
  const bodyHtml = String(raw.bodyHtml ?? '');
  const searchText = typeof raw.searchText === 'string' && raw.searchText
    ? raw.searchText
    : `${title}\n${htmlToText(bodyHtml)}`.toLowerCase();

  return {
    id: String(raw.id ?? ''),
    title,
    date: Number(raw.date) || 0,
    weather: raw.weather ? String(raw.weather) : '',
    bodyHtml,
    searchText,
  };
}

/* ------------------------------------------------------------------ *
 * 搜索与渲染
 * ------------------------------------------------------------------ */

function onSearchInput(event) {
  const value = event.target.value ?? '';
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    state.keyword = value.trim();
    render();
  }, DEBOUNCE_MS);
}

function render() {
  const needle = state.keyword.toLowerCase();
  const list = needle
    ? state.diaries.filter((diary) => diary.searchText.includes(needle))
    : state.diaries;

  if (!list.length) {
    els.list.replaceChildren();
    setStatus(needle
      ? `未找到与“${state.keyword}”相关的日记`
      : '还没有日记，在 diaries/ 目录添加 .md 文件即可。');
    return;
  }

  setStatus(needle ? `找到 ${list.length} 篇相关日记` : `共 ${state.diaries.length} 篇日记`);
  els.list.replaceChildren(...list.map((diary) => createCard(diary, needle)));
}

function createCard(diary, needle) {
  const card = document.createElement('article');
  card.className = 'diary-card';

  const title = document.createElement('h2');
  title.className = 'diary-title';
  title.append(...highlight(diary.title, needle));

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(
    createMetaItem('📅 日期：', formatTime(diary.date)),
    createMetaItem('⛅ 天气：', diary.weather || '-'),
  );

  const body = document.createElement('div');
  body.className = 'body';
  // 服务端已对 bodyHtml 做白名单净化
  body.innerHTML = diary.bodyHtml;

  card.append(title, meta, body);
  return card;
}

function createMetaItem(label, value) {
  const span = document.createElement('span');
  span.append(label, document.createTextNode(String(value)));
  return span;
}

/** 把标题按关键词切成文本节点与 <mark>，全部通过 DOM API 创建，天然免疫 XSS */
function highlight(text, needle) {
  const source = String(text ?? '');
  if (!needle) return [document.createTextNode(source)];

  const lower = source.toLowerCase();
  const nodes = [];
  let cursor = 0;
  let hit = lower.indexOf(needle);

  while (hit !== -1) {
    if (hit > cursor) nodes.push(document.createTextNode(source.slice(cursor, hit)));
    const mark = document.createElement('mark');
    mark.textContent = source.slice(hit, hit + needle.length);
    nodes.push(mark);
    cursor = hit + needle.length;
    hit = lower.indexOf(needle, cursor);
  }

  if (cursor < source.length) nodes.push(document.createTextNode(source.slice(cursor)));
  return nodes.length ? nodes : [document.createTextNode(source)];
}

function setStatus(message, kind = '') {
  if (!els.status) return;
  els.status.textContent = message;
  els.status.className = kind ? `status ${kind}` : 'status';
}

/* ------------------------------------------------------------------ *
 * 展示辅助
 * ------------------------------------------------------------------ */

function formatTime(ts) {
  const value = Number(ts);
  if (!value) return '-';

  const date = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
