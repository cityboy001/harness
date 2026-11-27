import { readFileSync } from 'node:fs';
import {
  DEFAULT_WORD_THEME,
  WORD_FONT_PRESETS,
  WORD_MARGIN_PRESETS,
  WORD_PAGE_WIDTH,
  WORD_TABLE_DENSITIES
} from './word-doc.mjs';

const wordBaseCss = readFileSync(new URL('../src/word-doc.css', import.meta.url), 'utf8');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function wordThemeStyleVars(theme = {}) {
  const fontPreset = WORD_FONT_PRESETS[theme.fontPreset] ?? WORD_FONT_PRESETS.sans;
  const margin = WORD_MARGIN_PRESETS[theme.pageMargin] ?? WORD_MARGIN_PRESETS.narrow;
  const density = WORD_TABLE_DENSITIES[theme.tableDensity] ?? WORD_TABLE_DENSITIES.compact;
  const fontSize = Number(theme.fontSize) || DEFAULT_WORD_THEME.fontSize;
  const lineHeight = Number(theme.lineHeight) || DEFAULT_WORD_THEME.lineHeight;
  const paraGap = Number(theme.paragraphSpacing ?? DEFAULT_WORD_THEME.paragraphSpacing);
  return [
    `--word-primary:${theme.primary || DEFAULT_WORD_THEME.primary}`,
    `--word-accent:${theme.accent || DEFAULT_WORD_THEME.accent}`,
    `--word-surface:${theme.surface || DEFAULT_WORD_THEME.surface}`,
    `--word-text:${theme.text || DEFAULT_WORD_THEME.text}`,
    `--word-muted:${theme.muted || DEFAULT_WORD_THEME.muted}`,
    `--word-border:${theme.border || DEFAULT_WORD_THEME.border}`,
    `--word-font:${theme.fontFamily || fontPreset.css}`,
    `--word-heading-font:${theme.headingFontFamily || fontPreset.headingCss}`,
    `--word-font-size:${fontSize}px`,
    `--word-line-height:${lineHeight}`,
    `--word-para-gap:${paraGap}px`,
    `--word-pad-x:${margin.padX}px`,
    `--word-pad-y:${margin.padY}px`,
    `--word-cell-pad-y:${density.cellPadY}px`,
    `--word-cell-pad-x:${density.cellPadX}px`,
    `--word-cell-font-size:${density.fontSize}px`
  ].join(';');
}

export function wordDocClassNames(doc) {
  const headingStyle = doc.theme?.headingStyle || DEFAULT_WORD_THEME.headingStyle;
  const classes = [`word-doc`, `word-template-${doc.templateId || 'default'}`, `word-heading-${headingStyle}`];
  if (doc.theme?.firstLineIndent) classes.push('word-indent');
  return classes.join(' ');
}

function renderCoverHtml(doc) {
  if (!doc.showCover) return '';
  const rows = [
    ['撰写单位', doc.meta?.organization],
    ['撰写人', doc.meta?.author],
    ['文档编号', doc.meta?.docNo],
    ['日期', doc.meta?.date]
  ].filter(([, val]) => val && String(val).trim());
  const metaTable = rows.length
    ? `<table class="word-cover-meta"><tbody>${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table>`
    : '';
  const kicker = doc.meta?.category
    ? `<div class="word-cover-kicker">${escapeHtml(doc.meta.category)}</div>`
    : '';
  const subtitle = doc.subtitle
    ? `<p class="word-cover-subtitle">${escapeHtml(doc.subtitle)}</p>`
    : '';
  return `<section class="word-sheet word-cover" data-word-part="cover">
  <div class="word-cover-main">
    ${kicker}
    <h1 class="word-cover-title">${escapeHtml(doc.title)}</h1>
    ${subtitle}
    <div class="word-cover-rule"></div>
  </div>
  ${metaTable}
</section>`;
}

function renderTocHtml(doc) {
  if (!doc.showToc || doc.sections.length < 2) return '';
  const items = doc.sections.map((section) => (
    `<li class="word-toc-item"><span class="word-toc-num">${String(section.index).padStart(2, '0')}</span><span>${escapeHtml(section.title)}</span></li>`
  )).join('');
  return `<section class="word-sheet word-toc" data-word-part="toc">
  <h2 class="word-toc-title">目录</h2>
  <ol class="word-toc-list">${items}</ol>
</section>`;
}

export function renderWordSectionsMarkup(doc, sectionIndices) {
  const targets = Array.isArray(sectionIndices) && sectionIndices.length
    ? doc.sections.filter(section => sectionIndices.includes(section.index))
    : doc.sections;
  return targets.map((section) => {
    const breakCls = section.pageBreakBefore ? ' word-page-break' : '';
    return `<article class="word-section${breakCls}" data-section-index="${section.index}">
  <h1 class="word-section-heading">${escapeHtml(section.title)}</h1>
  <div class="word-section-body">${section.html}</div>
</article>`;
  }).join('\n');
}

// 生成完整的独立 A4 Word HTML 文档，供 Playwright 排版自检、DOCX 导出和 PDF 导出共用
export function renderWordDocument(doc, sectionIndices) {
  const isPartial = Array.isArray(sectionIndices) && sectionIndices.length > 0;
  const cover = isPartial ? '' : renderCoverHtml(doc);
  const toc = isPartial ? '' : renderTocHtml(doc);
  const body = `<main class="word-sheet" data-word-part="body">${renderWordSectionsMarkup(doc, sectionIndices)}</main>`;
  const margin = WORD_MARGIN_PRESETS[doc.theme?.pageMargin] ?? WORD_MARGIN_PRESETS.narrow;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${WORD_PAGE_WIDTH}, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
html, body { margin: 0; padding: 0; background: #ffffff; }
@page { size: A4; margin: ${margin.mmTB}mm ${margin.mmLR}mm; }
@media print {
  .word-doc, .word-sheet { width: auto !important; padding: 0 !important; }
  .word-cover { min-height: 245mm !important; }
}
${wordBaseCss}
</style>
</head>
<body>
<div class="${escapeHtml(wordDocClassNames(doc))}" style="${escapeHtml(wordThemeStyleVars(doc.theme))}">
${cover}
${toc}
${body}
</div>
</body>
</html>`;
}
