import sanitizeHtml from 'sanitize-html';
import { PublicError } from './models.mjs';

export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;
export const MAX_SLIDES = 30;
export const MAX_SLIDE_HTML_BYTES = 36 * 1024;
export const MAX_DECK_BYTES = 600 * 1024;

export const DEFAULT_PPT_THEME = Object.freeze({
  name: '深海商务',
  primary: '#1E2761',
  secondary: '#F4F6FA',
  surface: '#FFFFFF',
  accent: '#00A896',
  text: '#1F2937',
  muted: '#64748B',
  onPrimary: '#FFFFFF',
  fontFamily: '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", Arial, sans-serif'
});

export const VALID_LAYOUTS = new Set([
  'cover', 'section', 'split', 'metrics', 'cards', 'comparison', 'timeline', 'table', 'chart', 'closing', 'custom'
]);

export const VALID_TRANSITIONS = new Set(['none', 'fade', 'push', 'wipe', 'zoom']);
export const VALID_ANIMS = new Set(['fade', 'fade-up', 'fly-left', 'fly-right', 'zoom-in', 'wipe']);
export const VALID_ANIM_TRIGGERS = new Set(['auto', 'click']);

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const SLIDE_TAGS = [
  'div', 'section', 'header', 'footer', 'main', 'article', 'aside', 'nav',
  'h1', 'h2', 'h3', 'h4', 'p', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'small', 'br', 'hr',
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

// 清理单个内联 style 属性，保留常规布局和视觉样式，移除外链或脚本风险
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

export function cleanSlideHtml(raw) {
  if (typeof raw !== 'string') throw new PublicError(422, '幻灯片 HTML 内容无效。');
  const unwrapped = raw.trim().replace(/^```(?:html)?\s*|\s*```$/gi, '');
  if (Buffer.byteLength(unwrapped, 'utf8') > MAX_SLIDE_HTML_BYTES) {
    throw new PublicError(422, '单页幻灯片 HTML 超过 36 KB 上限，请精简标记。');
  }
  const cleaned = sanitizeHtml(unwrapped, {
    allowedTags: SLIDE_TAGS,
    allowedAttributes: {
      '*': ['class', 'style', 'data-rasterize', 'data-anim', 'data-anim-order', 'data-anim-trigger', 'aria-label'],
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
        if (next['data-anim'] !== undefined) {
          const anim = String(next['data-anim']).trim().toLowerCase();
          if (VALID_ANIMS.has(anim)) next['data-anim'] = anim;
          else delete next['data-anim'];
        }
        if (next['data-anim-order'] !== undefined) {
          const order = Number.parseInt(String(next['data-anim-order']), 10);
          if (Number.isSafeInteger(order) && order >= 1 && order <= 20) next['data-anim-order'] = String(order);
          else delete next['data-anim-order'];
        }
        if (next['data-anim-trigger'] !== undefined) {
          const trigger = String(next['data-anim-trigger']).trim().toLowerCase();
          if (VALID_ANIM_TRIGGERS.has(trigger)) next['data-anim-trigger'] = trigger;
          else delete next['data-anim-trigger'];
        }
        return { tagName, attribs: next };
      }
    }
  }).trim();

  if (!cleaned || Buffer.byteLength(cleaned, 'utf8') > MAX_SLIDE_HTML_BYTES) {
    throw new PublicError(422, '幻灯片内容为空或超出大小上限。');
  }
  return cleaned;
}

function normalizeColor(value, label, defaultColor) {
  if (value === undefined || value === null || value === '') return defaultColor;
  if (typeof value !== 'string') throw new PublicError(422, `${label}必须是十六进制颜色，例如 #1E2761。`);
  const text = value.trim();
  if (!HEX_COLOR.test(text)) throw new PublicError(422, `${label}格式无效，需要 #RRGGBB 形式。`);
  return text.toUpperCase();
}

export function normalizeTheme(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim().slice(0, 40)
    : DEFAULT_PPT_THEME.name;
  return {
    name,
    primary: normalizeColor(source.primary, '主色 primary', DEFAULT_PPT_THEME.primary),
    secondary: normalizeColor(source.secondary, '背景色 secondary', DEFAULT_PPT_THEME.secondary),
    surface: normalizeColor(source.surface, '卡片色 surface', DEFAULT_PPT_THEME.surface),
    accent: normalizeColor(source.accent, '强调色 accent', DEFAULT_PPT_THEME.accent),
    text: normalizeColor(source.text, '正文色 text', DEFAULT_PPT_THEME.text),
    muted: normalizeColor(source.muted, '辅助文字色 muted', DEFAULT_PPT_THEME.muted),
    onPrimary: normalizeColor(source.onPrimary, '深底文字色 onPrimary', DEFAULT_PPT_THEME.onPrimary),
    fontFamily: DEFAULT_PPT_THEME.fontFamily
  };
}

export function normalizeSlide(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublicError(422, `第 ${index} 页幻灯片数据无效。`);
  }
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 120)
    : `第 ${index} 页`;
  const layout = typeof input.layout === 'string' && VALID_LAYOUTS.has(input.layout.trim())
    ? input.layout.trim()
    : 'custom';
  const tone = input.tone === 'dark' ? 'dark' : 'light';
  const transition = typeof input.transition === 'string' && VALID_TRANSITIONS.has(input.transition.trim())
    ? input.transition.trim()
    : 'fade';
  const html = cleanSlideHtml(input.html);
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) : '';
  return { index, title, layout, tone, transition, html, notes };
}

export function normalizeDeck(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublicError(422, 'PPT 数据结构无效。');
  }
  const title = typeof input.title === 'string' && input.title.trim()
    ? input.title.trim().slice(0, 100)
    : '未命名演示文稿';
  const templateId = typeof input.templateId === 'string' && /^[a-z0-9_-]{1,40}$/i.test(input.templateId.trim())
    ? input.templateId.trim()
    : 'default';
  const theme = normalizeTheme(input.theme);
  if (!Array.isArray(input.slides) || input.slides.length === 0 || input.slides.length > MAX_SLIDES) {
    throw new PublicError(422, `PPT 需要包含 1 到 ${MAX_SLIDES} 页幻灯片。`);
  }
  const slides = input.slides.map((slide, idx) => normalizeSlide(slide, idx + 1));
  const deck = { templateId, title, theme, slides };
  if (Buffer.byteLength(JSON.stringify(deck), 'utf8') > MAX_DECK_BYTES) {
    throw new PublicError(413, 'PPT 数据体积超过上限。');
  }
  return deck;
}
