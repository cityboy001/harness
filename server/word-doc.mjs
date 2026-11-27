import sanitizeHtml from 'sanitize-html';
import { PublicError } from './models.mjs';

export const WORD_PAGE_WIDTH = 794; // 96dpi A4 宽度（210mm）
export const WORD_PAGE_HEIGHT = 1123; // 96dpi A4 高度（297mm）
export const MAX_WORD_SECTIONS = 25;
export const MAX_SECTION_HTML_BYTES = 48 * 1024;
export const MAX_WORD_DOC_BYTES = 700 * 1024;

export const WORD_FONT_PRESETS = Object.freeze({
  sans: Object.freeze({
    css: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", Arial, sans-serif',
    headingCss: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", Arial, sans-serif',
    docx: 'Microsoft YaHei',
    docxHeading: 'Microsoft YaHei'
  }),
  serif: Object.freeze({
    css: '"SimSun", "Songti SC", "Noto Serif CJK SC", "STSong", serif',
    headingCss: '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif',
    docx: 'SimSun',
    docxHeading: 'SimHei'
  }),
  fangsong: Object.freeze({
    css: '"FangSong", "STFangsong", "FangSong_GB2312", "Noto Serif CJK SC", serif',
    headingCss: '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif',
    docx: 'FangSong',
    docxHeading: 'SimHei'
  }),
  kaiti: Object.freeze({
    css: '"KaiTi", "STKaiti", "Kaiti SC", serif',
    headingCss: '"KaiTi", "STKaiti", "Kaiti SC", serif',
    docx: 'KaiTi',
    docxHeading: 'KaiTi'
  })
});

export const WORD_MARGIN_PRESETS = Object.freeze({
  narrow: Object.freeze({ padX: 48, padY: 42, mmLR: 13, mmTB: 12, twipsLR: 737, twipsTB: 680 }),
  normal: Object.freeze({ padX: 72, padY: 62, mmLR: 19, mmTB: 17, twipsLR: 1080, twipsTB: 964 }),
  wide: Object.freeze({ padX: 94, padY: 78, mmLR: 25, mmTB: 21, twipsLR: 1417, twipsTB: 1190 })
});

export const WORD_TABLE_DENSITIES = Object.freeze({
  compact: Object.freeze({ cellPadY: 5, cellPadX: 8, fontSize: 13, docxPadY: 55, docxPadX: 90 }),
  normal: Object.freeze({ cellPadY: 8, cellPadX: 11, fontSize: 14, docxPadY: 80, docxPadX: 115 }),
  relaxed: Object.freeze({ cellPadY: 11, cellPadX: 14, fontSize: 14.5, docxPadY: 110, docxPadX: 140 })
});

export const VALID_WORD_FONT_PRESETS = new Set(Object.keys(WORD_FONT_PRESETS));
export const VALID_WORD_MARGINS = new Set(Object.keys(WORD_MARGIN_PRESETS));
export const VALID_WORD_HEADING_STYLES = new Set(['underline', 'bar', 'plain', 'center']);
export const VALID_WORD_TABLE_DENSITIES = new Set(Object.keys(WORD_TABLE_DENSITIES));

export const DEFAULT_WORD_THEME = Object.freeze({
  name: '商务蓝灰',
  primary: '#1E3A5F',
  accent: '#2563EB',
  surface: '#F8FAFC',
  text: '#1F2937',
  muted: '#64748B',
  border: '#CBD5E1',
  fontPreset: 'sans',
  fontSize: 14.5,
  lineHeight: 1.5,
  paragraphSpacing: 5,
  pageMargin: 'narrow',
  headingStyle: 'underline',
  firstLineIndent: false,
  tableDensity: 'compact',
  fontFamily: WORD_FONT_PRESETS.sans.css,
  headingFontFamily: WORD_FONT_PRESETS.sans.headingCss
});

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const WORD_TAGS = [
  'div', 'section', 'article', 'aside',
  'h1', 'h2', 'h3', 'h4', 'p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'sub', 'sup', 'br', 'hr',
  'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'figure', 'figcaption',
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'lineargradient', 'radialgradient', 'stop'
];

const SVG_ATTRS = [
  'viewbox', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-opacity', 'stroke',
  'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'opacity', 'transform', 'text-anchor', 'dominant-baseline', 'font-size', 'font-weight',
  'font-family', 'offset', 'stop-color', 'stop-opacity', 'id', 'preserveAspectRatio', 'xmlns'
];

const DANGEROUS_STYLE = /(?:url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding)/i;
const BLANK_LINE_RE = /(?<![A-Za-z0-9])(?:[_\uFF3F](?:(?:[ \u00A0\u3000]|&nbsp;)*[_\uFF3F])+)(?![A-Za-z0-9])/g;
const SKIP_BLANK_TAGS = new Set(['pre', 'code', 'svg']);

// 将正文中的连续/间隔下划线填空符规整为连续实线组件，避免中文字体渲染成断开的虚线
function normalizeBlankLines(html) {
  const tokens = html.split(/(<[^>]+>)/g);
  let skipDepth = 0;
  let blankDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith('<')) {
      const match = token.match(/^<\s*(\/?)\s*([a-zA-Z0-9-]+)/);
      if (!match) continue;
      const closing = Boolean(match[1]);
      const tag = match[2].toLowerCase();
      const selfClosing = /\/\s*>$/.test(token);
      if (SKIP_BLANK_TAGS.has(tag) && !selfClosing) {
        skipDepth = Math.max(0, skipDepth + (closing ? -1 : 1));
      } else if (tag === 'span' && !selfClosing) {
        if (!closing && /\bword-blank\b/.test(token)) blankDepth++;
        else if (closing && blankDepth > 0) blankDepth--;
      }
      continue;
    }
    if (skipDepth > 0 || blankDepth > 0) continue;
    tokens[i] = token.replace(BLANK_LINE_RE, (matched) => {
      let units = 0;
      for (const ch of matched) {
        if (ch === '_') units += 1;
        else if (ch === '\uFF3F') units += 1.6;
      }
      const cls = units <= 3.5
        ? 'word-blank word-blank-sm'
        : units <= 7.5
          ? 'word-blank'
          : 'word-blank word-blank-lg';
      return `<span class="${cls}">&nbsp;</span>`;
    });
  }
  return tokens.join('');
}

// 清理内联 style 属性，移除外链和脚本风险
function cleanStyleAttribute(raw) {
  if (typeof raw !== 'string') return '';
  const kept = [];
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const prop = trimmed.slice(0, colon).trim().toLowerCase();
    const val = trimmed.slice(colon + 1).trim();
    if (!/^(?:--[a-z0-9-]+|[a-z-]+)$/.test(prop) || !val) continue;
    if (DANGEROUS_STYLE.test(val)) continue;
    if (prop === 'position' && /^fixed$/i.test(val)) continue;
    kept.push(`${prop}: ${val}`);
  }
  return kept.join('; ');
}

export function cleanWordSectionHtml(raw) {
  if (typeof raw !== 'string') throw new PublicError(422, '文档章节 HTML 内容无效。');
  const unwrapped = raw.trim().replace(/^```(?:html)?\s*|\s*```$/gi, '');
  if (Buffer.byteLength(unwrapped, 'utf8') > MAX_SECTION_HTML_BYTES) {
    throw new PublicError(422, '单个章节 HTML 超过 48 KB 上限，请拆分章节或精简标记。');
  }
  const cleaned = sanitizeHtml(unwrapped, {
    allowedTags: WORD_TAGS,
    allowedAttributes: {
      '*': ['class', 'style', 'data-rasterize', 'aria-label'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
      svg: SVG_ATTRS,
      g: SVG_ATTRS,
      path: SVG_ATTRS,
      rect: SVG_ATTRS,
      circle: SVG_ATTRS,
      ellipse: SVG_ATTRS,
      line: SVG_ATTRS,
      polyline: SVG_ATTRS,
      polygon: SVG_ATTRS,
      text: SVG_ATTRS,
      tspan: SVG_ATTRS,
      defs: SVG_ATTRS,
      linearGradient: SVG_ATTRS,
      radialGradient: SVG_ATTRS,
      lineargradient: SVG_ATTRS,
      radialgradient: SVG_ATTRS,
      stop: SVG_ATTRS
    },
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    nonTextTags: ['head', 'script', 'style', 'textarea', 'option', 'xmp', 'iframe', 'object', 'embed', 'noscript', 'template', 'foreignObject'],
    transformTags: {
      '*': (tagName, attribs) => {
        const next = { ...attribs };
        if (typeof next.style === 'string') {
          const safeStyle = cleanStyleAttribute(next.style);
          if (safeStyle) next.style = safeStyle;
          else delete next.style;
        }
        return { tagName, attribs: next };
      }
    }
  }).trim();

  const normalized = normalizeBlankLines(cleaned);
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > MAX_SECTION_HTML_BYTES) {
    throw new PublicError(422, '章节内容为空或超出大小上限。');
  }
  return normalized;
}

function normalizeColor(value, label, defaultColor) {
  if (value === undefined || value === null || value === '') return defaultColor;
  if (typeof value !== 'string') throw new PublicError(422, `${label}必须是十六进制颜色，例如 #1E3A5F。`);
  const text = value.trim();
  if (!HEX_COLOR.test(text)) throw new PublicError(422, `${label}格式无效，需要 #RRGGBB 形式。`);
  return text.toUpperCase();
}

function normalizeNumber(value, label, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new PublicError(422, `${label}必须在 ${min} 到 ${max} 之间。`);
  }
  return Math.round(num * 100) / 100;
}

function normalizeEnum(value, label, validSet, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !validSet.has(value.trim())) {
    throw new PublicError(422, `${label}必须是 ${[...validSet].join(' / ')} 之一。`);
  }
  return value.trim();
}

export function normalizeWordTheme(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 40)
    : DEFAULT_WORD_THEME.name;
  const fontPreset = normalizeEnum(source.fontPreset, '字体风格 fontPreset', VALID_WORD_FONT_PRESETS, DEFAULT_WORD_THEME.fontPreset);
  const preset = WORD_FONT_PRESETS[fontPreset];
  return {
    name,
    primary: normalizeColor(source.primary, '主色 primary', DEFAULT_WORD_THEME.primary),
    accent: normalizeColor(source.accent, '强调色 accent', DEFAULT_WORD_THEME.accent),
    surface: normalizeColor(source.surface, '浅底色 surface', DEFAULT_WORD_THEME.surface),
    text: normalizeColor(source.text, '正文色 text', DEFAULT_WORD_THEME.text),
    muted: normalizeColor(source.muted, '辅助文字色 muted', DEFAULT_WORD_THEME.muted),
    border: normalizeColor(source.border, '边框色 border', DEFAULT_WORD_THEME.border),
    fontPreset,
    fontSize: normalizeNumber(source.fontSize, '正文字号 fontSize', 12, 18, DEFAULT_WORD_THEME.fontSize),
    lineHeight: normalizeNumber(source.lineHeight, '行高倍率 lineHeight', 1.2, 2.2, DEFAULT_WORD_THEME.lineHeight),
    paragraphSpacing: normalizeNumber(source.paragraphSpacing, '段后间距 paragraphSpacing', 2, 20, DEFAULT_WORD_THEME.paragraphSpacing),
    pageMargin: normalizeEnum(source.pageMargin, '页边距 pageMargin', VALID_WORD_MARGINS, DEFAULT_WORD_THEME.pageMargin),
    headingStyle: normalizeEnum(source.headingStyle, '一级标题样式 headingStyle', VALID_WORD_HEADING_STYLES, DEFAULT_WORD_THEME.headingStyle),
    firstLineIndent: Boolean(source.firstLineIndent),
    tableDensity: normalizeEnum(source.tableDensity, '表格紧凑度 tableDensity', VALID_WORD_TABLE_DENSITIES, DEFAULT_WORD_THEME.tableDensity),
    fontFamily: preset.css,
    headingFontFamily: preset.headingCss
  };
}

export function normalizeWordMeta(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const cleanField = (val, max = 80) => typeof val === 'string' ? val.trim().slice(0, max) : '';
  return {
    author: cleanField(source.author, 60),
    organization: cleanField(source.organization, 80),
    date: cleanField(source.date, 40),
    docNo: cleanField(source.docNo, 40),
    category: cleanField(source.category, 40)
  };
}

export function normalizeWordSection(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublicError(422, `第 ${index} 章数据无效。`);
  }
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 120)
    : `第 ${index} 章`;
  const html = cleanWordSectionHtml(input.html);
  const pageBreakBefore = Boolean(input.pageBreakBefore);
  return { index, title, html, pageBreakBefore };
}

export function normalizeWordDoc(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublicError(422, 'Word 文档数据结构无效。');
  }
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 120)
    : '未命名文档';
  const subtitle = typeof input.subtitle === 'string' ? input.subtitle.trim().slice(0, 200) : '';
  const templateId = typeof input.templateId === 'string' && /^[a-z0-9_-]{1,40}$/i.test(input.templateId.trim())
    ? input.templateId.trim()
    : 'default';
  const theme = normalizeWordTheme(input.theme);
  const meta = normalizeWordMeta(input.meta);
  const headerText = typeof input.headerText === 'string' && input.headerText.trim()
    ? input.headerText.trim().slice(0, 80)
    : title;
  const showCover = input.showCover !== false;
  const showToc = input.showToc !== false;
  const showHeaderFooter = input.showHeaderFooter !== false;
  if (!Array.isArray(input.sections) || input.sections.length === 0 || input.sections.length > MAX_WORD_SECTIONS) {
    throw new PublicError(422, `Word 文档需要包含 1 到 ${MAX_WORD_SECTIONS} 个章节。`);
  }
  const sections = input.sections.map((section, idx) => normalizeWordSection(section, idx + 1));
  const doc = { templateId, title, subtitle, meta, theme, headerText, showCover, showToc, showHeaderFooter, sections };
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > MAX_WORD_DOC_BYTES) {
    throw new PublicError(413, 'Word 文档数据体积超过上限。');
  }
  return doc;
}
