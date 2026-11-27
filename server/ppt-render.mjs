import { readFileSync } from 'node:fs';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './ppt-deck.mjs';

const slideBaseCss = readFileSync(new URL('../src/ppt-slide.css', import.meta.url), 'utf8');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function themeStyleVars(theme) {
  return [
    `--ppt-primary:${theme.primary}`,
    `--ppt-secondary:${theme.secondary}`,
    `--ppt-surface:${theme.surface}`,
    `--ppt-accent:${theme.accent}`,
    `--ppt-text:${theme.text}`,
    `--ppt-muted:${theme.muted}`,
    `--ppt-on-primary:${theme.onPrimary}`,
    `--ppt-font:${theme.fontFamily}`
  ].join(';');
}

export function renderSlideMarkup(slide, theme, templateId = 'default') {
  const toneClass = slide.tone === 'dark' ? 'ppt-slide--dark' : 'ppt-slide--light';
  return `<section class="ppt-slide ${toneClass} ppt-template-${escapeHtml(templateId)}" data-slide-index="${slide.index}" style="${escapeHtml(themeStyleVars(theme))}">${slide.html}</section>`;
}

// 生成完整的独立幻灯片 HTML 文档，供 Playwright 排版检查、PPTX 导出和 PDF 导出共用
export function renderDeckDocument(deck, slideIndices) {
  const targets = Array.isArray(slideIndices) && slideIndices.length
    ? deck.slides.filter(slide => slideIndices.includes(slide.index))
    : deck.slides;
  const body = targets.map(slide => renderSlideMarkup(slide, deck.theme, deck.templateId)).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${SLIDE_WIDTH}, initial-scale=1">
<title>${escapeHtml(deck.title)}</title>
<style>
html, body { margin: 0; padding: 0; background: #ffffff; }
@page { size: ${SLIDE_WIDTH}px ${SLIDE_HEIGHT}px; margin: 0; }
.ppt-slide { page-break-after: always; break-after: page; }
.ppt-slide:last-child { page-break-after: auto; break-after: auto; }
${slideBaseCss}
</style>
</head>
<body>
${body}
</body>
</html>`;
}
