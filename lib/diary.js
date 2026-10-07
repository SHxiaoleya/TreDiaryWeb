'use strict';

/**
 * 日记站点的核心逻辑（与 HTTP 框架解耦，便于单元测试）。
 *
 * 职责：
 *  - 扫描 diaries/ 目录并按 mtime 缓存解析结果
 *  - 解析 front matter、渲染 Markdown、净化 HTML
 *  - 提供查询过滤与请求头（ETag）处理
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const DIARY_FILE_RE = /\.md$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

/**
 * 把 front matter 里的日期解析为毫秒时间戳。
 * 支持：毫秒/秒时间戳、`2026-04-28`、`2026-04-28 21:04`、ISO 字符串、Date 对象。
 * 无法解析时返回 `fallback`（通常是文件修改时间），避免排序与展示出现 0/NaN。
 */
function parseDiaryDate(value, fallback = 0) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : fallback;
  }

  if (typeof value === 'number') {
    return normalizeTimestamp(value, fallback);
  }

  const text = String(value ?? '').trim();
  if (!text) return fallback;

  if (/^\d+$/.test(text)) {
    return normalizeTimestamp(Number(text), fallback);
  }

  // 纯日期按 UTC 零点解析，避免不同时区出现「差一天」
  const parsed = DATE_ONLY_RE.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeTimestamp(value, fallback) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  // 小于 1e12 视为秒级时间戳
  return value < 1e12 ? value * 1000 : value;
}

/** HTML → 纯文本，用于搜索匹配（服务端计算一次，客户端不再重复解析） */
function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * HTML 净化：Markdown 正文由客户端 innerHTML 注入，这里做白名单过滤
 * ------------------------------------------------------------------ */

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'input', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub', 'sup',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

// 这些标签连同内容一起丢弃
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'title']);

const ALLOWED_ATTRS = {
  '*': new Set(['class', 'title', 'colspan', 'rowspan', 'start', 'align']),
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height']),
  input: new Set(['type', 'checked', 'disabled']),
};

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#34': '"', '#38': '&',
};

// 未加引号的属性值不能包含 `/`，否则会把自闭合标签的斜杠吞进值里
const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/]+)))?/g;

function fromCodePoint(code) {
  // 超出 Unicode 范围或代理区时原样保留，避免抛错中断整个请求
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : null;
}

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    const key = entity.toLowerCase();
    if (key.startsWith('#x')) {
      return fromCodePoint(parseInt(key.slice(2), 16)) ?? match;
    }
    if (key.startsWith('#')) {
      return fromCodePoint(parseInt(key.slice(1), 10)) ?? match;
    }
    return NAMED_ENTITIES[key] ?? match;
  });
}

function escapeAttribute(value) {
  return decodeEntities(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeUrl(value) {
  // 去掉控制字符后判断协议，防止 `java\nscript:` 之类的绕过
  const url = decodeEntities(value).replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase();
  if (!url) return false;
  if (url.startsWith('#')) return true;
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/.test(url)
    || /^(?:https?:|mailto:|tel:)/.test(url);
}

function sanitizeAttributes(tag, rawAttrs) {
  const allowed = ALLOWED_ATTRS[tag] || ALLOWED_ATTRS['*'];
  const out = [];

  ATTRIBUTE_RE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_RE.exec(rawAttrs)) !== null) {
    const name = match[1].toLowerCase();
    if (name === 'style' || name.startsWith('on') || name === 'srcdoc') continue;
    if (!allowed.has(name) && !ALLOWED_ATTRS['*'].has(name)) continue;

    const rawValue = match[2] ?? match[3] ?? match[4];
    if (rawValue === undefined) {
      out.push(` ${name}`);
      continue;
    }
    if ((name === 'href' || name === 'src') && !isSafeUrl(rawValue)) continue;

    const value = escapeAttribute(rawValue);
    out.push(name === 'src' || name === 'href'
      ? ` ${name}="${value}"${name === 'src' && tag === 'img' ? ' loading="lazy"' : ''}`
      : ` ${name}="${value}"`);
  }

  return out.join('');
}

/**
 * 白名单式 HTML 净化：保留 Markdown 常用结构，丢弃脚本、事件属性与危险协议。
 * 无第三方依赖，行为可预期；如需更严格策略可自行替换。
 */
function sanitizeHtml(html) {
  const input = String(html ?? '');
  let output = '';
  let index = 0;
  let dropDepth = 0;
  let dropTag = '';

  while (index < input.length) {
    const open = input.indexOf('<', index);
    if (open === -1) {
      if (!dropDepth) output += input.slice(index);
      break;
    }
    if (!dropDepth) output += input.slice(index, open);

    if (input.startsWith('<!--', open)) {
      const end = input.indexOf('-->', open + 4);
      index = end === -1 ? input.length : end + 3;
      continue;
    }

    const close = input.indexOf('>', open + 1);
    if (close === -1) break;

    const raw = input.slice(open + 1, close);
    const isClosing = raw.startsWith('/');
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    if (!nameMatch) {
      if (!dropDepth) output += input.slice(open, close + 1);
      index = close + 1;
      continue;
    }

    const tag = nameMatch[1].toLowerCase();
    const rest = raw.slice(nameMatch[0].length);
    const selfClosing = /\/\s*$/.test(rest) || VOID_TAGS.has(tag);

    if (DROP_TAGS.has(tag)) {
      if (!isClosing) {
        dropTag = tag;
        dropDepth += 1;
      } else if (tag === dropTag) {
        dropDepth = Math.max(0, dropDepth - 1);
      }
      index = close + 1;
      continue;
    }

    if (dropDepth || !ALLOWED_TAGS.has(tag)) {
      index = close + 1;
      continue;
    }

    output += isClosing
      ? `</${tag}>`
      : `<${tag}${sanitizeAttributes(tag, rest)}${selfClosing ? ' /' : ''}>`;
    index = close + 1;
  }

  return output;
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解析单个日记文件。
 * @returns {{id:string,title:string,date:number,weather:string,bodyHtml:string,searchText:string}}
 */
function parseDiary(raw, fileName, fallbackDate = 0) {
  const { data, content } = matter(stripBom(String(raw)));
  const bodyHtml = sanitizeHtml(marked.parse(content || ''));
  const title = String(data.title || fileName.replace(DIARY_FILE_RE, ''));

  return {
    id: fileName,
    title,
    date: parseDiaryDate(data.date, fallbackDate),
    weather: data.weather ? String(data.weather) : '',
    bodyHtml,
    // 搜索用小写全文，客户端直接复用，避免每次输入都解析 HTML
    searchText: `${title}\n${htmlToText(bodyHtml)}`.toLowerCase(),
  };
}

/** 列出 diaries/ 下的 Markdown 文件（目录不存在时返回空数组） */
function listDiaryFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }

  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && DIARY_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/* ------------------------------------------------------------------ *
 * 缓存与查询
 * ------------------------------------------------------------------ */

/**
 * 创建带 mtime 缓存的日记仓库：文件未变化时直接复用上次的解析结果。
 */
function createDiaryStore(dir) {
  const cache = new Map(); // fileName -> { mtimeMs, size, diary }

  function readOne(fileName) {
    const fullPath = path.join(dir, fileName);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }

    const cached = cache.get(fileName);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.diary;
    }

    const diary = parseDiary(fs.readFileSync(fullPath, 'utf-8'), fileName, Math.round(stat.mtimeMs));
    cache.set(fileName, { mtimeMs: stat.mtimeMs, size: stat.size, diary });
    return diary;
  }

  return {
    /** 读取全部日记，按日期倒序 */
    listAll() {
      const names = listDiaryFiles(dir);

      // 清理已删除文件的缓存，避免内存无限增长
      const alive = new Set(names);
      for (const key of cache.keys()) {
        if (!alive.has(key)) cache.delete(key);
      }

      const diaries = [];
      for (const name of names) {
        const diary = readOne(name);
        if (diary) diaries.push(diary);
      }

      diaries.sort((a, b) => b.date - a.date || a.id.localeCompare(b.id));
      return diaries;
    },
    get size() {
      return cache.size;
    },
  };
}

/** 关键词过滤：同时匹配标题与正文（searchText 为小写全文） */
function filterDiaries(diaries, keyword) {
  const needle = String(keyword ?? '').trim().toLowerCase();
  if (!needle) return diaries;
  return diaries.filter((diary) => {
    const haystack = diary.searchText ?? `${diary.title || ''}\n${htmlToText(diary.bodyHtml || '')}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** 依据列表内容生成弱 ETag，支持 304 条件请求 */
function makeEtag(diaries) {
  let hash = 2166136261;
  for (const diary of diaries) {
    const token = `${diary.id}:${diary.date}:${diary.bodyHtml.length}:${diary.title}`;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `W/"${diaries.length}-${(hash >>> 0).toString(36)}"`;
}

/* ------------------------------------------------------------------ *
 * HTTP 接口（依赖注入 express，避免 lib 直接耦合框架）
 * ------------------------------------------------------------------ */

const PUBLIC_CACHE_CONTROL = 'public, max-age=300, must-revalidate';

/**
 * 创建 Express 应用。
 * @param {object} options
 * @param {string} options.diaryDir   日记目录绝对路径
 * @param {string} options.publicDir  静态资源目录绝对路径
 * @param {object} options.express    express 模块
 */
function createApp({ diaryDir, publicDir, express }) {
  if (!express) throw new TypeError('createApp 需要 express 模块');
  const app = express();
  const store = createDiaryStore(diaryDir);

  app.disable('x-powered-by');
  app.set('etag', false); // API 手动处理 ETag

  // 静态资源：HTML 不缓存，CSS/JS/图片短缓存并支持条件请求
  app.use(express.static(publicDir, {
    index: 'index.html',
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (/\.html?$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
        return;
      }
      res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    },
  }));

  app.get('/api/diaries', (req, res) => {
    try {
      const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      const diaries = filterDiaries(store.listAll(), keyword);

      // 内容哈希 ETag：客户端始终重验证，未变化时返回 304 省掉重复传输
      const etag = makeEtag(diaries);
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch.split(/\s*,\s*/).includes(etag)) {
        res.status(304).end();
        return;
      }

      res.json({ count: diaries.length, diaries });
    } catch (err) {
      console.error('[api] 读取日记失败:', err);
      res.status(500).json({ message: '读取日记失败', error: err.message });
    }
  });

  return app;
}

module.exports = {
  createApp,
  createDiaryStore,
  filterDiaries,
  htmlToText,
  makeEtag,
  parseDiary,
  parseDiaryDate,
  sanitizeHtml,
  listDiaryFiles,
};
