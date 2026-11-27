import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType
} from 'docx';
import {
  DEFAULT_WORD_THEME,
  WORD_FONT_PRESETS,
  WORD_MARGIN_PRESETS,
  WORD_PAGE_HEIGHT,
  WORD_PAGE_WIDTH,
  WORD_TABLE_DENSITIES
} from './word-doc.mjs';
import { renderWordDocument } from './word-render.mjs';
import { withPptPage } from './ppt-browser.mjs';

const A4_WIDTH_TWIPS = 11906; // 210mm
const A4_HEIGHT_TWIPS = 16838; // 297mm
const MAX_IMAGE_WIDTH_PX = 580; // 约 153mm，安全落在 A4 正文区内
const pxToTwips = (px) => Math.max(0, Math.round((Number(px) || 0) * 15));
const fontSpec = (name) => ({ ascii: name, hAnsi: name, eastAsia: name, cs: name });

// 基于浏览器实际计算出的 lineHeight 与段内最大字号生成精确固定值行距，避免 Word/WPS 文档网格把行距强行拉大成 2 倍
function resolveLineSpacing(lineHeightPx, runs, fallbackRatio, fallbackSizePt) {
  const maxPt = runs.reduce((acc, r) => {
    if (r.isBreak) return acc;
    const pt = r.fontSize ? Math.max(8, Math.round(r.fontSize * 0.75 * 2) / 2) : fallbackSizePt;
    return Math.max(acc, pt);
  }, fallbackSizePt);
  const rawTwips = Number.isFinite(lineHeightPx) && lineHeightPx > 0
    ? Math.round(lineHeightPx * 15)
    : Math.round(maxPt * fallbackRatio * 20);
  const minTwips = Math.round(maxPt * 1.18 * 20);
  const maxTwips = Math.round(maxPt * 2.35 * 20);
  return {
    line: Math.max(minTwips, Math.min(maxTwips, rawTwips)),
    lineRule: LineRuleType.EXACT
  };
}

const stripHash = (hex, fallback = '1F2937') => {
  if (typeof hex !== 'string') return fallback;
  const clean = hex.trim().replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(clean) ? clean.toUpperCase() : fallback;
};

// 解析 CSS rgb/rgba 为 6 位无 # 十六进制颜色
function cssColorToHex(raw, fallback = null) {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.slice(1).toUpperCase();
  const match = trimmed.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!match) return fallback;
  const a = match[4] === undefined ? 1 : Number(match[4]);
  if (a <= 0.02) return fallback;
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0').toUpperCase();
  return toHex(match[1]) + toHex(match[2]) + toHex(match[3]);
}

function mapAlignment(align) {
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right' || align === 'end') return AlignmentType.RIGHT;
  if (align === 'justify') return AlignmentType.JUSTIFIED;
  return AlignmentType.LEFT;
}

// 在真实 A4 宽度 Chromium 中执行 Word 文档排版自检（水平溢出、裁剪、字号过小、过窄表格列与估算页数）
export async function inspectWordInBrowser(doc, sectionIndices, signal) {
  const html = renderWordDocument(doc, sectionIndices);
  const configuredFontSize = Number(doc.theme?.fontSize) || DEFAULT_WORD_THEME.fontSize;
  const minBodyFontPx = Math.max(11, Math.min(13, configuredFontSize - 0.8));
  return withPptPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    return page.evaluate(({ minBodyFontPx }) => {
      const INLINE_TAGS = new Set(['SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SMALL', 'CODE', 'SUB', 'SUP', 'BR']);
      const sheet = document.querySelector('[data-word-part="body"]');
      const sheetRect = sheet ? sheet.getBoundingClientRect() : { left: 0, right: 794, width: 794 };
      const sheetStyle = sheet ? getComputedStyle(sheet) : null;
      const padL = sheetStyle ? (parseFloat(sheetStyle.paddingLeft) || 0) : 74;
      const padR = sheetStyle ? (parseFloat(sheetStyle.paddingRight) || 0) : 74;
      const contentLeft = sheetRect.left + padL;
      const contentRight = sheetRect.right - padR;

      const sections = [...document.querySelectorAll('article.word-section')];
      const errors = [];
      const warnings = [];
      const summary = [];

      const textPreview = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 36);
      const isVisible = (el) => {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0.5 && r.height > 0.5;
      };

      for (const secEl of sections) {
        const index = Number(secEl.dataset.sectionIndex || 0);
        const secErrors = [];
        const secWarnings = [];
        let totalChars = 0;

        // 1. 检查整章水平溢出
        const overflowX = Math.round(secEl.scrollWidth - secEl.clientWidth);
        if (overflowX > 4) {
          secErrors.push({
            section: index,
            type: 'horizontal_overflow',
            message: `第 ${index} 章内容水平超出 A4 正文宽度 ${overflowX}px，请缩减表格列数或 SVG 宽度。`
          });
        }

        // 2. 遍历可见子元素检查越界、裁切、表格过窄与字号
        const walker = document.createTreeWalker(secEl, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const el = node;
          if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
          if (!isVisible(el)) continue;
          const st = getComputedStyle(el);
          const r = el.getBoundingClientRect();

          if (r.right > contentRight + 6 || r.left < contentLeft - 6) {
            const label = textPreview(el) || el.tagName.toLowerCase();
            secErrors.push({
              section: index,
              type: 'out_of_bounds',
              element: label,
              message: `第 ${index} 章元素「${label}」超出 A4 页面正文左右边距，请调整宽度。`
            });
          }

          if (el.tagName.toLowerCase() !== 'svg' && el.clientWidth > 0 && el.clientHeight > 0) {
            const clippedX = Math.round(el.scrollWidth - el.clientWidth);
            const clippedY = Math.round(el.scrollHeight - el.clientHeight);
            const clipsX = st.overflowX === 'hidden' || st.overflowX === 'clip';
            const clipsY = st.overflowY === 'hidden' || st.overflowY === 'clip';
            if ((clipsX && clippedX > 5) || (clipsY && clippedY > 5)) {
              const label = textPreview(el) || el.tagName.toLowerCase();
              secErrors.push({
                section: index,
                type: 'element_overflow',
                element: label,
                message: `第 ${index} 章元素「${label}」内容被裁切（水平 ${Math.max(0, clippedX)}px，垂直 ${Math.max(0, clippedY)}px）。`
              });
            }
          }

          // 检查表格单列过窄导致文字挤压成竖条
          if (el.tagName === 'TD' || el.tagName === 'TH') {
            const cellText = textPreview(el);
            if (cellText.length >= 6 && r.width < 46) {
              secErrors.push({
                section: index,
                type: 'narrow_table_cell',
                element: cellText,
                message: `第 ${index} 章表格单元格「${cellText}」宽度仅 ${Math.round(r.width)}px 过窄，请减少列数或精简表头。`
              });
            }
          }

          if (el.tagName.toLowerCase() === 'svg' || ['TABLE', 'THEAD', 'TBODY', 'TR'].includes(el.tagName)) continue;
          const childElements = [...el.children];
          const hasBlockChild = childElements.some(child => !INLINE_TAGS.has(child.tagName));
          const isLeafText = !hasBlockChild && (el.innerText || '').trim().length > 0;
          const parentIsLeaf = el.parentElement && el.parentElement !== secEl && INLINE_TAGS.has(el.tagName);

          if (isLeafText && !parentIsLeaf) {
            const text = (el.innerText || '').trim();
            totalChars += text.length;
            const fontSize = parseFloat(st.fontSize);
            const isCaptionOrMeta = Boolean(el.closest('figcaption, .word-kpi-label, pre, code, th, td'));
            if (fontSize > 0 && fontSize < 11) {
              secErrors.push({
                section: index,
                type: 'font_too_small',
                element: text.slice(0, 30),
                message: `第 ${index} 章文字「${text.slice(0, 30)}」字号仅 ${Math.round(fontSize)}px，小于 11px 最低可读标准。`
              });
            } else if (!isCaptionOrMeta && (el.tagName === 'P' || el.tagName === 'LI') && fontSize > 0 && fontSize < minBodyFontPx) {
              secErrors.push({
                section: index,
                type: 'font_too_small',
                element: text.slice(0, 30),
                message: `第 ${index} 章正文段落「${text.slice(0, 30)}」字号仅 ${Math.round(fontSize)}px 偏小，低于当前基准要求。`
              });
            }
          }
        }

        if (totalChars < 30) {
          secWarnings.push({
            section: index,
            type: 'sparse_section',
            message: `第 ${index} 章正文不足 30 字，建议充实内容或与其他章节合并。`
          });
        }

        errors.push(...secErrors.slice(0, 8));
        warnings.push(...secWarnings.slice(0, 5));
        summary.push({
          section: index,
          ok: secErrors.length === 0,
          chars: totalChars,
          errorCount: secErrors.length,
          warningCount: secWarnings.length
        });
      }

      const padT = sheetStyle ? (parseFloat(sheetStyle.paddingTop) || 0) : 62;
      const padB = sheetStyle ? (parseFloat(sheetStyle.paddingBottom) || 0) : 62;
      const printableH = Math.max(600, 1123 - padT - padB);
      const contentH = sheet ? Math.max(0, sheet.scrollHeight - padT - padB) : 800;
      const estimatedBodyPages = Math.max(1, Math.ceil(contentH / printableH));
      const extraPages = (document.querySelector('[data-word-part="cover"]') ? 1 : 0) +
        (document.querySelector('[data-word-part="toc"]') ? 1 : 0);

      return {
        ok: errors.length === 0,
        estimatedPages: estimatedBodyPages + extraPages,
        sections: summary,
        errors,
        warnings
      };
    }, { minBodyFontPx });
  }, { deviceScaleFactor: 1, viewport: { width: WORD_PAGE_WIDTH, height: WORD_PAGE_HEIGHT }, signal });
}

// 将提取出的富文本 runs 转为 docx TextRun 数组
function buildTextRuns(runs, defaultStyle = {}) {
  const defaultFont = defaultStyle.font || WORD_FONT_PRESETS.sans.docx;
  const out = [];
  for (const run of runs) {
    if (run.isBreak) {
      out.push(new TextRun({ break: 1 }));
      continue;
    }
    if (!run.text) continue;
    const sizePt = run.fontSize ? Math.max(8, Math.round(run.fontSize * 0.75 * 2) / 2) : (defaultStyle.sizePt ?? 11);
    const color = run.colorHex ?? defaultStyle.color;
    out.push(new TextRun({
      text: run.text,
      font: fontSpec(run.code ? 'Consolas' : defaultFont),
      size: Math.round(sizePt * 2), // docx 字号单位为半磅（half-point）
      bold: run.bold ?? defaultStyle.bold ?? false,
      italics: run.italic ?? defaultStyle.italics ?? false,
      underline: run.underline ? {} : undefined,
      strike: run.strike ? true : undefined,
      color: color || undefined,
      shading: run.code ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F1F5F9' } : undefined
    }));
  }
  return out;
}

// 导出同源、原生可编辑的 .docx 文档（兼容 Microsoft Word 与 WPS 文字）
export async function exportWordToDocx(doc, signal) {
  const html = renderWordDocument(doc);
  const primaryHex = stripHash(doc.theme?.primary, '1E3A5F');
  const accentHex = stripHash(doc.theme?.accent, '2563EB');
  const surfaceHex = stripHash(doc.theme?.surface, 'F8FAFC');
  const textHex = stripHash(doc.theme?.text, '1F2937');
  const mutedHex = stripHash(doc.theme?.muted, '64748B');
  const borderHex = stripHash(doc.theme?.border, 'CBD5E1');
  const fontPreset = WORD_FONT_PRESETS[doc.theme?.fontPreset] ?? WORD_FONT_PRESETS.sans;
  const bodyFont = fontPreset.docx;
  const headingFont = fontPreset.docxHeading;
  const marginPreset = WORD_MARGIN_PRESETS[doc.theme?.pageMargin] ?? WORD_MARGIN_PRESETS.narrow;
  const marginLR = marginPreset.twipsLR;
  const marginTB = marginPreset.twipsTB;
  const contentWidthTwips = A4_WIDTH_TWIPS - marginLR * 2;
  const tableDensity = WORD_TABLE_DENSITIES[doc.theme?.tableDensity] ?? WORD_TABLE_DENSITIES.compact;
  const baseFontSizePx = Number(doc.theme?.fontSize) || DEFAULT_WORD_THEME.fontSize;
  const baseBodyPt = Math.max(9, Math.round(baseFontSizePx * 0.75 * 2) / 2);
  const baseLineHeight = Number(doc.theme?.lineHeight) || DEFAULT_WORD_THEME.lineHeight;
  const baseParaGapTwips = pxToTwips(doc.theme?.paragraphSpacing ?? DEFAULT_WORD_THEME.paragraphSpacing);
  const headingStyle = doc.theme?.headingStyle || DEFAULT_WORD_THEME.headingStyle;
  const showHeaderFooter = doc.showHeaderFooter !== false;

  const extracted = await withPptPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);

    // 1. 在浏览器内把各章节 DOM 解析为结构化块列表，并标记需要 2x 截图的 SVG / data-rasterize 元素
    const parsed = await page.evaluate(() => {
      const INLINE_TAGS = new Set(['SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SMALL', 'CODE', 'SUB', 'SUP', 'BR']);
      let rasterCounter = 0;

      const isVisible = (el) => {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0.5 && r.height > 0.5;
      };

      const extractRuns = (root) => {
        const runs = [];
        const walk = (node, codeCtx = false) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.replace(/\s+/g, ' ');
            if (!text) return;
            const parent = node.parentElement || root;
            const st = getComputedStyle(parent);
            const weight = Number(st.fontWeight) || (st.fontWeight === 'bold' ? 700 : 400);
            const deco = st.textDecorationLine || '';
            runs.push({
              text,
              color: st.color,
              fontSize: parseFloat(st.fontSize) || 15,
              bold: weight >= 600,
              italic: st.fontStyle === 'italic',
              underline: deco.includes('underline'),
              strike: deco.includes('line-through'),
              code: codeCtx
            });
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          if (node.tagName === 'BR') {
            runs.push({ isBreak: true });
            return;
          }
          if (node.classList?.contains('word-blank')) {
            const st = getComputedStyle(node);
            const fontSize = parseFloat(st.fontSize) || 15;
            const rect = node.getBoundingClientRect();
            const inner = (node.textContent || '').replace(/\u00A0/g, ' ').trim();
            const spaces = Math.max(4, Math.round(rect.width / (fontSize * 0.42)));
            const text = inner ? `\u00A0${inner}\u00A0` : '\u00A0'.repeat(spaces);
            const weight = Number(st.fontWeight) || (st.fontWeight === 'bold' ? 700 : 400);
            runs.push({
              text,
              color: st.color,
              fontSize,
              bold: weight >= 600,
              italic: st.fontStyle === 'italic',
              underline: true,
              strike: false,
              code: false,
              preserveBlank: true
            });
            return;
          }
          const nextCode = codeCtx || node.tagName === 'CODE';
          for (const child of node.childNodes) walk(child, nextCode);
        };
        walk(root);
        // 清理首尾多余空白（保留填空实线）
        while (runs.length && !runs[0].isBreak && !runs[0].preserveBlank && !runs[0].text.trim()) runs.shift();
        while (runs.length && !runs[runs.length - 1].isBreak && !runs[runs.length - 1].preserveBlank && !runs[runs.length - 1].text.trim()) runs.pop();
        if (runs.length && !runs[0].isBreak && !runs[0].preserveBlank) runs[0].text = runs[0].text.replace(/^\s+/, '');
        if (runs.length && !runs[runs.length - 1].isBreak && !runs[runs.length - 1].preserveBlank) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
        return runs;
      };

      const parseLineHeightPx = (st) => {
        const lh = parseFloat(st.lineHeight);
        return Number.isFinite(lh) && lh > 0 ? lh : null;
      };

      const extractListItems = (listEl, level = 0, out = []) => {
        const ordered = listEl.tagName === 'OL';
        const listSt = getComputedStyle(listEl);
        const listGapPx = parseFloat(listSt.rowGap || listSt.gap) || 0;
        for (const child of listEl.children) {
          if (child.tagName !== 'LI' || !isVisible(child)) continue;
          const nestedLists = [];
          const ownRuns = [];
          for (const node of child.childNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && (node.tagName === 'UL' || node.tagName === 'OL')) {
              nestedLists.push(node);
            } else {
              const tempRuns = [];
              if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent.replace(/\s+/g, ' ');
                if (text.trim()) {
                  const st = getComputedStyle(child);
                  const weight = Number(st.fontWeight) || (st.fontWeight === 'bold' ? 700 : 400);
                  tempRuns.push({
                    text,
                    color: st.color,
                    fontSize: parseFloat(st.fontSize) || 14.5,
                    bold: weight >= 600,
                    italic: st.fontStyle === 'italic',
                    underline: false,
                    strike: false,
                    code: false
                  });
                }
              } else if (node.nodeType === Node.ELEMENT_NODE) {
                tempRuns.push(...extractRuns(node));
              }
              ownRuns.push(...tempRuns);
            }
          }
          if (ownRuns.length) {
            if (!ownRuns[0].isBreak && !ownRuns[0].preserveBlank) ownRuns[0].text = ownRuns[0].text.replace(/^\s+/, '');
            if (!ownRuns[ownRuns.length - 1].isBreak && !ownRuns[ownRuns.length - 1].preserveBlank) ownRuns[ownRuns.length - 1].text = ownRuns[ownRuns.length - 1].text.replace(/\s+$/, '');
            const liSt = getComputedStyle(child);
            out.push({
              ordered,
              level: Math.min(2, level),
              lineHeightPx: parseLineHeightPx(liSt),
              marginBottomPx: Math.max(parseFloat(liSt.marginBottom) || 0, listGapPx),
              runs: ownRuns
            });
          }
          for (const sub of nestedLists) extractListItems(sub, level + 1, out);
        }
        return out;
      };

      const extractTable = (tableEl) => {
        const rows = [];
        const tableRect = tableEl.getBoundingClientRect();
        const colWidthsPx = [];
        const firstRow = tableEl.querySelector('tr');
        if (firstRow) {
          for (const cell of firstRow.children) {
            if (cell.tagName !== 'TH' && cell.tagName !== 'TD') continue;
            const span = Math.max(1, Number(cell.getAttribute('colspan')) || 1);
            const w = cell.getBoundingClientRect().width / span;
            for (let i = 0; i < span; i++) colWidthsPx.push(w);
          }
        }
        const totalW = colWidthsPx.reduce((a, b) => a + b, 0) || tableRect.width || 1;
        const colRatios = colWidthsPx.map(w => w / totalW);

        for (const tr of tableEl.querySelectorAll('tr')) {
          const cells = [];
          let isHeaderRow = false;
          for (const cell of tr.children) {
            if (cell.tagName !== 'TH' && cell.tagName !== 'TD') continue;
            const st = getComputedStyle(cell);
            const isHeader = cell.tagName === 'TH' || Boolean(cell.closest('thead'));
            if (isHeader) isHeaderRow = true;
            cells.push({
              isHeader,
              colspan: Math.max(1, Number(cell.getAttribute('colspan')) || 1),
              rowspan: Math.max(1, Number(cell.getAttribute('rowspan')) || 1),
              align: st.textAlign,
              bgColor: st.backgroundColor,
              lineHeightPx: parseLineHeightPx(st),
              runs: extractRuns(cell)
            });
          }
          if (cells.length) rows.push({ isHeaderRow, cells });
        }
        return { kind: 'table', colRatios, rows };
      };

      const extractSectionBlocks = (container) => {
        const blocks = [];
        const visit = (el) => {
          if (!isVisible(el)) return;
          const tag = el.tagName.toLowerCase();

          // 1) SVG 或显式 data-rasterize 块
          if (tag === 'svg' || el.dataset?.rasterize === 'true') {
            const opId = `word-op-${rasterCounter++}`;
            el.setAttribute('data-word-op', opId);
            const r = el.getBoundingClientRect();
            blocks.push({ kind: 'raster', opId, width: r.width, height: r.height, caption: '' });
            return;
          }

          // 2) figure（包含 SVG + figcaption）
          if (tag === 'figure') {
            const target = el.querySelector('svg, [data-rasterize="true"]');
            const captionEl = el.querySelector('figcaption');
            const caption = captionEl ? (captionEl.innerText || '').trim() : '';
            if (target && isVisible(target)) {
              const opId = `word-op-${rasterCounter++}`;
              target.setAttribute('data-word-op', opId);
              const r = target.getBoundingClientRect();
              blocks.push({ kind: 'raster', opId, width: r.width, height: r.height, caption });
              return;
            }
          }

          // 3) KPI 指标行卡片（转为等宽原生 Word 表格，避免横排错位）
          if (el.classList.contains('word-kpi-row')) {
            const cards = [...el.querySelectorAll('.word-kpi-card')].filter(isVisible).map((card) => {
              const st = getComputedStyle(card);
              const valEl = card.querySelector('.word-kpi-value');
              const lblEl = card.querySelector('.word-kpi-label');
              return {
                value: valEl ? (valEl.innerText || '').trim() : '',
                label: lblEl ? (lblEl.innerText || '').trim() : (card.innerText || '').trim(),
                accentColor: st.borderTopColor,
                bgColor: st.backgroundColor
              };
            }).filter(c => c.value || c.label);
            if (cards.length) {
              blocks.push({ kind: 'kpi_row', cards });
              return;
            }
          }

          // 4) 重点提示块 / 引用块
          if (tag === 'blockquote' || el.classList.contains('word-callout')) {
            const st = getComputedStyle(el);
            const paragraphs = [];
            const blockKids = [...el.children].filter(c => !INLINE_TAGS.has(c.tagName) && isVisible(c));
            if (blockKids.length) {
              for (const kid of blockKids) {
                const runs = extractRuns(kid);
                if (runs.length) {
                  paragraphs.push({
                    isTitle: kid.classList.contains('word-callout-title') || /^H[1-4]$/.test(kid.tagName),
                    runs
                  });
                }
              }
            } else {
              const runs = extractRuns(el);
              if (runs.length) paragraphs.push({ isTitle: false, runs });
            }
            if (paragraphs.length) {
              blocks.push({
                kind: 'callout',
                borderColor: st.borderLeftColor,
                bgColor: st.backgroundColor,
                paragraphs
              });
            }
            return;
          }

          // 5) 表格
          if (tag === 'table') {
            blocks.push(extractTable(el));
            return;
          }

          // 6) 标题 h1-h4
          if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
            const st = getComputedStyle(el);
            const runs = extractRuns(el);
            if (runs.length) {
              blocks.push({
                kind: 'heading',
                level: Number(tag[1]),
                align: st.textAlign,
                lineHeightPx: parseLineHeightPx(st),
                marginTopPx: parseFloat(st.marginTop) || 0,
                marginBottomPx: parseFloat(st.marginBottom) || 0,
                runs
              });
            }
            return;
          }

          // 7) 有序/无序列表
          if (tag === 'ul' || tag === 'ol') {
            const items = extractListItems(el, 0, []);
            if (items.length) blocks.push({ kind: 'list', items });
            return;
          }

          // 8) 代码块
          if (tag === 'pre') {
            const text = (el.innerText || el.textContent || '').replace(/\r\n/g, '\n').trimEnd();
            if (text) blocks.push({ kind: 'code_block', text });
            return;
          }

          // 9) 分割线
          if (tag === 'hr') {
            blocks.push({ kind: 'hr' });
            return;
          }

          // 10) 普通段落或纯内联文本块
          const childElements = [...el.children];
          const hasBlockChild = childElements.some(child => !INLINE_TAGS.has(child.tagName));
          if (tag === 'p' || (!hasBlockChild && (el.innerText || '').trim().length > 0)) {
            const st = getComputedStyle(el);
            const runs = extractRuns(el);
            if (runs.length) {
              blocks.push({
                kind: 'paragraph',
                align: st.textAlign,
                lineHeightPx: parseLineHeightPx(st),
                marginTopPx: parseFloat(st.marginTop) || 0,
                marginBottomPx: parseFloat(st.marginBottom) || 0,
                textIndentPx: parseFloat(st.textIndent) || 0,
                bgColor: st.backgroundColor,
                runs
              });
            }
            return;
          }

          // 11) 容器元素递归遍历子块
          for (const child of el.children) visit(child);
        };

        for (const child of container.children) visit(child);
        return blocks;
      };

      const sections = [...document.querySelectorAll('article.word-section')].map((secEl) => {
        const bodyEl = secEl.querySelector('.word-section-body') || secEl;
        return {
          index: Number(secEl.dataset.sectionIndex || 0),
          blocks: extractSectionBlocks(bodyEl)
        };
      });

      return { sections };
    });

    // 2. 对所有标记的 SVG / 视觉图执行 2x 清晰截图
    const rasters = new Map();
    for (const sec of parsed.sections) {
      for (const block of sec.blocks) {
        if (block.kind !== 'raster') continue;
        const loc = page.locator(`[data-word-op="${block.opId}"]`);
        const png = await loc.screenshot({ type: 'png', omitBackground: true });
        rasters.set(block.opId, png);
      }
    }

    return { sections: parsed.sections, rasters };
  }, { deviceScaleFactor: 2, viewport: { width: WORD_PAGE_WIDTH, height: WORD_PAGE_HEIGHT }, signal });

  // 3. 组装原生 docx 子节点列表
  const children = [];

  // 3.1 封面页
  if (doc.showCover) {
    if (doc.meta?.category) {
      children.push(new Paragraph({
        spacing: { before: 800, after: 200 },
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: surfaceHex },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: accentHex, space: 10 } },
        indent: { left: 120 },
        children: [new TextRun({ text: doc.meta.category, font: fontSpec(headingFont), size: 22, bold: true, color: primaryHex })]
      }));
    }
    children.push(new Paragraph({
      spacing: { before: doc.meta?.category ? 400 : 1200, after: 240 },
      children: [new TextRun({ text: doc.title, font: fontSpec(headingFont), size: 54, bold: true, color: primaryHex })]
    }));
    if (doc.subtitle) {
      children.push(new Paragraph({
        spacing: { before: 0, after: 320 },
        children: [new TextRun({ text: doc.subtitle, font: fontSpec(bodyFont), size: 28, color: mutedHex })]
      }));
    }
    children.push(new Paragraph({
      spacing: { before: 120, after: 1400 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: accentHex, space: 4 } },
      children: [new TextRun({ text: ' ', size: 8 })]
    }));

    const metaRows = [
      ['撰写单位', doc.meta?.organization],
      ['撰写人', doc.meta?.author],
      ['文档编号', doc.meta?.docNo],
      ['日期', doc.meta?.date]
    ].filter(([, val]) => val && String(val).trim());

    if (metaRows.length) {
      const col1 = Math.round(contentWidthTwips * 0.24);
      const col2 = contentWidthTwips - col1;
      children.push(new Table({
        width: { size: contentWidthTwips, type: WidthType.DXA },
        layout: TableLayoutType.FIXED,
        columnWidths: [col1, col2],
        borders: {
          top: { style: BorderStyle.SINGLE, size: 12, color: primaryHex },
          bottom: { style: BorderStyle.SINGLE, size: 6, color: borderHex },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
          left: { style: BorderStyle.NONE, size: 0, color: 'auto' },
          right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
          insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' }
        },
        rows: metaRows.map(([k, v]) => new TableRow({
          cantSplit: true,
          children: [
            new TableCell({
              width: { size: col1, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: surfaceHex },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              verticalAlign: VerticalAlign.CENTER,
              children: [new Paragraph({ children: [new TextRun({ text: k, font: fontSpec(headingFont), size: 22, bold: true, color: primaryHex })] })]
            }),
            new TableCell({
              width: { size: col2, type: WidthType.DXA },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              verticalAlign: VerticalAlign.CENTER,
              children: [new Paragraph({ children: [new TextRun({ text: String(v), font: fontSpec(bodyFont), size: 22, color: textHex })] })]
            })
          ]
        }))
      }));
    }

    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  // 3.2 目录页（清晰章节索引，WPS 与 Word 打开直接可见）
  if (doc.showToc && doc.sections.length >= 2) {
    children.push(new Paragraph({
      spacing: { before: 120, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: primaryHex, space: 6 } },
      children: [new TextRun({ text: '目录', font: fontSpec(headingFont), size: 34, bold: true, color: primaryHex })]
    }));
    for (const sec of doc.sections) {
      children.push(new Paragraph({
        spacing: { before: 60, after: 60, line: 340, lineRule: LineRuleType.EXACT },
        border: { bottom: { style: BorderStyle.DOTTED, size: 4, color: borderHex, space: 4 } },
        children: [
          new TextRun({ text: `${String(sec.index).padStart(2, '0')}   `, font: fontSpec(headingFont), size: 23, bold: true, color: accentHex }),
          new TextRun({ text: sec.title, font: fontSpec(bodyFont), size: 23, color: textHex })
        ]
      }));
    }
    children.push(new Paragraph({ children: [new PageBreak()] }));
  }

  const spacerAfterBlock = () => new Paragraph({
    spacing: { before: 0, after: Math.max(40, Math.round(baseParaGapTwips * 0.7)), line: 40, lineRule: LineRuleType.EXACT },
    children: []
  });

  // 3.3 正文各章节
  const h1SizeHalfPt = Math.round(Math.max(14, baseBodyPt * 1.48) * 2);
  const h1CenterSizeHalfPt = Math.round(Math.max(15, baseBodyPt * 1.6) * 2);
  for (let sIdx = 0; sIdx < doc.sections.length; sIdx++) {
    const secMeta = doc.sections[sIdx];
    const parsedSec = extracted.sections.find(item => item.index === secMeta.index) || { blocks: [] };

    // 一级章节标题（Heading 1，按 headingStyle 同步呈现下划线/左侧色条/纯文字/居中标题）
    const h1Base = {
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: secMeta.pageBreakBefore && sIdx > 0,
      keepNext: true,
      spacing: {
        before: sIdx === 0 ? 40 : Math.max(180, Math.round(baseParaGapTwips * 2.2)),
        after: Math.max(100, Math.round(baseParaGapTwips * 1.4)),
        line: Math.round((headingStyle === 'center' ? h1CenterSizeHalfPt : h1SizeHalfPt) * 10 * 1.32),
        lineRule: LineRuleType.EXACT
      },
      children: [new TextRun({
        text: secMeta.title,
        font: fontSpec(headingFont),
        size: headingStyle === 'center' ? h1CenterSizeHalfPt : h1SizeHalfPt,
        bold: true,
        color: primaryHex
      })]
    };
    if (headingStyle === 'underline') {
      h1Base.border = { bottom: { style: BorderStyle.SINGLE, size: 10, color: primaryHex, space: 6 } };
    } else if (headingStyle === 'bar') {
      h1Base.border = { left: { style: BorderStyle.SINGLE, size: 24, color: accentHex, space: 8 } };
      h1Base.shading = { type: ShadingType.CLEAR, color: 'auto', fill: surfaceHex };
      h1Base.indent = { left: 100 };
    } else if (headingStyle === 'center') {
      h1Base.alignment = AlignmentType.CENTER;
    }
    children.push(new Paragraph(h1Base));

    for (const block of parsedSec.blocks) {
      if (block.kind === 'heading') {
        const headingMap = {
          1: { level: HeadingLevel.HEADING_2, sizePt: Math.round(baseBodyPt * 1.28 * 2) / 2, color: primaryHex, before: Math.max(140, Math.round(baseParaGapTwips * 1.8)), after: Math.max(60, baseParaGapTwips) },
          2: { level: HeadingLevel.HEADING_2, sizePt: Math.round(baseBodyPt * 1.22 * 2) / 2, color: primaryHex, before: Math.max(120, Math.round(baseParaGapTwips * 1.6)), after: Math.max(60, baseParaGapTwips) },
          3: { level: HeadingLevel.HEADING_3, sizePt: Math.round(baseBodyPt * 1.08 * 2) / 2, color: textHex, before: Math.max(100, Math.round(baseParaGapTwips * 1.3)), after: Math.max(50, Math.round(baseParaGapTwips * 0.8)) },
          4: { level: HeadingLevel.HEADING_4, sizePt: baseBodyPt, color: textHex, before: Math.max(80, baseParaGapTwips), after: Math.max(40, Math.round(baseParaGapTwips * 0.7)) }
        };
        const cfg = headingMap[block.level] || headingMap[3];
        const runs = block.runs.map(r => ({ ...r, bold: true, fontSize: r.fontSize || cfg.sizePt / 0.75, colorHex: cssColorToHex(r.color, cfg.color) }));
        const lineSpec = resolveLineSpacing(block.lineHeightPx, runs, 1.38, cfg.sizePt);
        children.push(new Paragraph({
          heading: cfg.level,
          alignment: mapAlignment(block.align),
          keepNext: true,
          spacing: {
            before: block.marginTopPx ? pxToTwips(block.marginTopPx) : cfg.before,
            after: block.marginBottomPx ? pxToTwips(block.marginBottomPx) : cfg.after,
            ...lineSpec
          },
          children: buildTextRuns(runs, { font: headingFont, sizePt: cfg.sizePt, bold: true, color: cfg.color })
        }));
        continue;
      }

      if (block.kind === 'paragraph') {
        const runs = block.runs.map(r => ({ ...r, colorHex: cssColorToHex(r.color, textHex) }));
        const lineSpec = resolveLineSpacing(block.lineHeightPx, runs, baseLineHeight, baseBodyPt);
        const bgHex = cssColorToHex(block.bgColor, null);
        const firstLineTwips = block.textIndentPx > 1 ? pxToTwips(block.textIndentPx) : 0;
        children.push(new Paragraph({
          alignment: mapAlignment(block.align),
          ...(firstLineTwips ? { indent: { firstLine: firstLineTwips } } : {}),
          ...(bgHex && bgHex !== 'FFFFFF' ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: bgHex } } : {}),
          spacing: {
            before: block.marginTopPx ? pxToTwips(block.marginTopPx) : 0,
            after: block.marginBottomPx !== undefined ? pxToTwips(block.marginBottomPx) : baseParaGapTwips,
            ...lineSpec
          },
          children: buildTextRuns(runs, { font: bodyFont, sizePt: baseBodyPt, color: textHex })
        }));
        continue;
      }

      if (block.kind === 'list') {
        for (const item of block.items) {
          const runs = item.runs.map(r => ({ ...r, colorHex: cssColorToHex(r.color, textHex) }));
          const lineSpec = resolveLineSpacing(item.lineHeightPx, runs, baseLineHeight, baseBodyPt);
          const itemAfter = item.marginBottomPx ? pxToTwips(item.marginBottomPx) : Math.max(30, Math.round(baseParaGapTwips * 0.55));
          children.push(new Paragraph({
            numbering: { reference: item.ordered ? 'word-ordered' : 'word-bullet', level: item.level },
            spacing: { before: 0, after: itemAfter, ...lineSpec },
            children: buildTextRuns(runs, { font: bodyFont, sizePt: baseBodyPt, color: textHex })
          }));
        }
        continue;
      }

      if (block.kind === 'callout') {
        const leftHex = cssColorToHex(block.borderColor, accentHex);
        const bgHex = cssColorToHex(block.bgColor, surfaceHex);
        const calloutParas = block.paragraphs.map((p, idx) => {
          const runs = p.runs.map(r => ({
            ...r,
            bold: p.isTitle ? true : r.bold,
            colorHex: cssColorToHex(r.color, p.isTitle ? primaryHex : textHex)
          }));
          const pt = p.isTitle ? baseBodyPt + 0.5 : Math.max(9.5, baseBodyPt - 0.5);
          const lineSpec = resolveLineSpacing(null, runs, Math.min(1.55, baseLineHeight), pt);
          return new Paragraph({
            spacing: { before: idx === 0 ? 0 : 40, after: idx === block.paragraphs.length - 1 ? 0 : 40, ...lineSpec },
            children: buildTextRuns(runs, { font: p.isTitle ? headingFont : bodyFont, sizePt: pt, bold: p.isTitle, color: p.isTitle ? primaryHex : textHex })
          });
        });
        children.push(new Table({
          width: { size: contentWidthTwips, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: [contentWidthTwips],
          borders: {
            left: { style: BorderStyle.SINGLE, size: 24, color: leftHex },
            top: { style: BorderStyle.NONE, size: 0, color: 'auto' },
            right: { style: BorderStyle.NONE, size: 0, color: 'auto' },
            bottom: { style: BorderStyle.NONE, size: 0, color: 'auto' },
            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
            insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' }
          },
          rows: [new TableRow({
            cantSplit: true,
            children: [new TableCell({
              width: { size: contentWidthTwips, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: bgHex },
              margins: { top: 110, bottom: 110, left: 180, right: 160 },
              children: calloutParas
            })]
          })]
        }));
        children.push(spacerAfterBlock());
        continue;
      }

      if (block.kind === 'kpi_row') {
        const count = block.cards.length;
        const colW = Math.floor(contentWidthTwips / count);
        const colWidths = Array.from({ length: count }, (_, idx) => idx === count - 1 ? contentWidthTwips - colW * (count - 1) : colW);
        children.push(new Table({
          width: { size: contentWidthTwips, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: colWidths,
          borders: {
            top: { style: BorderStyle.SINGLE, size: 18, color: accentHex },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            left: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            right: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            insideVertical: { style: BorderStyle.SINGLE, size: 6, color: 'FFFFFF' },
            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' }
          },
          rows: [new TableRow({
            cantSplit: true,
            children: block.cards.map((card, idx) => new TableCell({
              width: { size: colWidths[idx], type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: cssColorToHex(card.bgColor, surfaceHex) },
              margins: { top: 110, bottom: 110, left: 140, right: 140 },
              verticalAlign: VerticalAlign.CENTER,
              children: [
                ...(card.value ? [new Paragraph({
                  spacing: { before: 0, after: 40, line: 420, lineRule: LineRuleType.EXACT },
                  children: [new TextRun({ text: card.value, font: fontSpec(headingFont), size: 36, bold: true, color: primaryHex })]
                })] : []),
                ...(card.label ? [new Paragraph({
                  spacing: { before: 0, after: 0, line: 260, lineRule: LineRuleType.EXACT },
                  children: [new TextRun({ text: card.label, font: fontSpec(bodyFont), size: 19, color: mutedHex })]
                })] : [])
              ]
            }))
          })]
        }));
        children.push(spacerAfterBlock());
        continue;
      }

      if (block.kind === 'table' && block.rows.length) {
        const colCount = Math.max(
          block.colRatios.length,
          ...block.rows.map(r => r.cells.reduce((sum, c) => sum + c.colspan, 0))
        );
        const ratios = block.colRatios.length === colCount
          ? block.colRatios
          : Array.from({ length: colCount }, () => 1 / colCount);
        const colWidths = ratios.map(r => Math.max(600, Math.round(contentWidthTwips * r)));
        // 校准末列使总宽严格等于正文宽
        const diff = contentWidthTwips - colWidths.reduce((a, b) => a + b, 0);
        if (colWidths.length) colWidths[colWidths.length - 1] = Math.max(600, colWidths[colWidths.length - 1] + diff);
        const cellDefaultPt = Math.max(9, Math.round(tableDensity.fontSize * 0.75 * 2) / 2);

        const tableRows = block.rows.map((row, rIdx) => {
          let colCursor = 0;
          const cells = row.cells.map((cell) => {
            const span = Math.max(1, cell.colspan);
            let cellWidth = 0;
            for (let k = 0; k < span; k++) cellWidth += colWidths[colCursor + k] ?? colWidths[colWidths.length - 1];
            colCursor += span;
            const defaultFill = cell.isHeader ? primaryHex : (rIdx % 2 === 0 ? null : surfaceHex);
            const fillHex = cssColorToHex(cell.bgColor, defaultFill);
            const defaultTextColor = cell.isHeader ? 'FFFFFF' : textHex;
            const runs = cell.runs.map(r => ({
              ...r,
              bold: cell.isHeader ? true : r.bold,
              colorHex: cell.isHeader ? 'FFFFFF' : cssColorToHex(r.color, defaultTextColor)
            }));
            const cellLineSpec = resolveLineSpacing(cell.lineHeightPx, runs, Math.min(1.42, baseLineHeight), cellDefaultPt);
            return new TableCell({
              columnSpan: span > 1 ? span : undefined,
              rowSpan: cell.rowspan > 1 ? cell.rowspan : undefined,
              width: { size: cellWidth, type: WidthType.DXA },
              shading: fillHex ? { type: ShadingType.CLEAR, color: 'auto', fill: fillHex } : undefined,
              margins: { top: tableDensity.docxPadY, bottom: tableDensity.docxPadY, left: tableDensity.docxPadX, right: tableDensity.docxPadX },
              verticalAlign: VerticalAlign.CENTER,
              children: [new Paragraph({
                alignment: mapAlignment(cell.align),
                spacing: { before: 0, after: 0, ...cellLineSpec },
                children: buildTextRuns(runs, { font: cell.isHeader ? headingFont : bodyFont, sizePt: cellDefaultPt, bold: cell.isHeader, color: defaultTextColor })
              })]
            });
          });
          return new TableRow({
            tableHeader: row.isHeaderRow && rIdx === 0,
            cantSplit: true,
            children: cells
          });
        });

        children.push(new Table({
          width: { size: contentWidthTwips, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: colWidths,
          borders: {
            top: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
            bottom: { style: BorderStyle.SINGLE, size: 6, color: primaryHex },
            left: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            right: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            insideVertical: { style: BorderStyle.SINGLE, size: 4, color: borderHex }
          },
          rows: tableRows
        }));
        children.push(spacerAfterBlock());
        continue;
      }

      if (block.kind === 'code_block') {
        const lines = block.text.split('\n');
        children.push(new Table({
          width: { size: contentWidthTwips, type: WidthType.DXA },
          layout: TableLayoutType.FIXED,
          columnWidths: [contentWidthTwips],
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            left: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            right: { style: BorderStyle.SINGLE, size: 4, color: borderHex },
            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'auto' },
            insideVertical: { style: BorderStyle.NONE, size: 0, color: 'auto' }
          },
          rows: [new TableRow({
            cantSplit: true,
            children: [new TableCell({
              width: { size: contentWidthTwips, type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: surfaceHex },
              margins: { top: 100, bottom: 100, left: 150, right: 150 },
              children: lines.map(line => new Paragraph({
                spacing: { before: 0, after: 0, line: 260, lineRule: LineRuleType.EXACT },
                children: [new TextRun({ text: line || ' ', font: fontSpec('Consolas'), size: 19, color: textHex })]
              }))
            })]
          })]
        }));
        children.push(spacerAfterBlock());
        continue;
      }

      if (block.kind === 'hr') {
        children.push(new Paragraph({
          spacing: { before: 80, after: 100, line: 60, lineRule: LineRuleType.EXACT },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: borderHex, space: 1 } },
          children: []
        }));
        continue;
      }

      if (block.kind === 'raster') {
        const png = extracted.rasters.get(block.opId);
        if (!png) continue;
        const scale = block.width > MAX_IMAGE_WIDTH_PX ? MAX_IMAGE_WIDTH_PX / block.width : 1;
        const targetW = Math.max(40, Math.round(block.width * scale));
        const targetH = Math.max(30, Math.round(block.height * scale));
        children.push(new Paragraph({
          alignment: AlignmentType.CENTER,
          keepNext: Boolean(block.caption),
          spacing: { before: 100, after: block.caption ? 40 : 100 },
          children: [new ImageRun({ type: 'png', data: png, transformation: { width: targetW, height: targetH } })]
        }));
        if (block.caption) {
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 120, line: 260, lineRule: LineRuleType.EXACT },
            children: [new TextRun({ text: block.caption, font: fontSpec(bodyFont), size: 19, color: mutedHex })]
          }));
        }
      }
    }
  }

  const headerText = doc.headerText || doc.title;
  const docxDoc = new Document({
    title: doc.title,
    creator: doc.meta?.author || 'AI Document Workbench',
    styles: {
      default: {
        document: {
          run: {
            font: fontSpec(bodyFont),
            size: Math.round(baseBodyPt * 2),
            color: textHex
          }
        }
      }
    },
    numbering: {
      config: [
        {
          reference: 'word-bullet',
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 220 } } } },
            { level: 1, format: LevelFormat.BULLET, text: '\u25E6', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 820, hanging: 220 } } } },
            { level: 2, format: LevelFormat.BULLET, text: '\u25AA', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1220, hanging: 220 } } } }
          ]
        },
        {
          reference: 'word-ordered',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 420, hanging: 260 } } } },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2)', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 820, hanging: 260 } } } },
            { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1220, hanging: 260 } } } }
          ]
        }
      ]
    },
    sections: [
      {
        properties: {
          titlePage: doc.showCover,
          page: {
            size: { width: A4_WIDTH_TWIPS, height: A4_HEIGHT_TWIPS },
            margin: { top: marginTB, bottom: marginTB, left: marginLR, right: marginLR }
          }
        },
        ...(showHeaderFooter ? {
          headers: {
            default: new Header({
              children: [new Paragraph({
                alignment: AlignmentType.RIGHT,
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: borderHex, space: 4 } },
                children: [new TextRun({ text: headerText, font: fontSpec(bodyFont), size: 18, color: mutedHex })]
              })]
            }),
            first: new Header({ children: [] })
          },
          footers: {
            default: new Footer({
              children: [new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: '第 ', font: fontSpec(bodyFont), size: 18, color: mutedHex }),
                  new TextRun({ children: [PageNumber.CURRENT], font: fontSpec(bodyFont), size: 18, color: mutedHex }),
                  new TextRun({ text: ' 页 / 共 ', font: fontSpec(bodyFont), size: 18, color: mutedHex }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], font: fontSpec(bodyFont), size: 18, color: mutedHex }),
                  new TextRun({ text: ' 页', font: fontSpec(bodyFont), size: 18, color: mutedHex })
                ]
              })]
            }),
            first: new Footer({ children: [] })
          }
        } : {}),
        children
      }
    ]
  });

  return Buffer.from(await Packer.toBuffer(docxDoc));
}

// 导出高保真 A4 PDF（与浏览器渲染完全一致）
export async function exportWordToPdf(doc, signal) {
  const html = renderWordDocument(doc);
  const margin = WORD_MARGIN_PRESETS[doc.theme?.pageMargin] ?? WORD_MARGIN_PRESETS.narrow;
  const showHeaderFooter = doc.showHeaderFooter !== false;
  const topMm = showHeaderFooter ? Math.max(16, margin.mmTB) : margin.mmTB;
  const bottomMm = showHeaderFooter ? Math.max(16, margin.mmTB) : margin.mmTB;
  return withPptPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    await page.emulateMedia({ media: 'print' });
    const headerTitle = String(doc.headerText || doc.title || '').replace(/[<>&"]/g, '');
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: showHeaderFooter,
      ...(showHeaderFooter ? {
        headerTemplate: `<div style="width:100%;font-size:9px;color:#64748b;text-align:right;padding:0 ${margin.mmLR}mm;font-family:'Microsoft YaHei',sans-serif;">${headerTitle}</div>`,
        footerTemplate: `<div style="width:100%;font-size:9px;color:#64748b;text-align:center;font-family:'Microsoft YaHei',sans-serif;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>`
      } : {}),
      margin: { top: `${topMm}mm`, bottom: `${bottomMm}mm`, left: `${margin.mmLR}mm`, right: `${margin.mmLR}mm` }
    });
    return Buffer.from(pdf);
  }, { deviceScaleFactor: 2, viewport: { width: WORD_PAGE_WIDTH, height: WORD_PAGE_HEIGHT }, signal });
}
