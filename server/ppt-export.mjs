import PptxGenJS from 'pptxgenjs';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from './ppt-deck.mjs';
import { renderDeckDocument } from './ppt-render.mjs';
import { withPptPage } from './ppt-browser.mjs';
import { applyPptxAnimations } from './ppt-anim.mjs';

const PX_PER_INCH = 96;
const SLIDE_W_IN = SLIDE_WIDTH / PX_PER_INCH; // 13.3333 in
const SLIDE_H_IN = SLIDE_HEIGHT / PX_PER_INCH; // 7.5 in
const pxToIn = (px) => Math.round((px / PX_PER_INCH) * 10000) / 10000;
const pxToPt = (px) => Math.round((px * 0.75) * 100) / 100;

function pickFontFace(fontFamily) {
  if (typeof fontFamily !== 'string' || !fontFamily.trim()) return 'Microsoft YaHei';
  const first = fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
  return first || 'Microsoft YaHei';
}

// 在真实 Chromium 中测量幻灯片排版：溢出、越界、重叠、过小字号与文字密度
export async function inspectDeckInBrowser(deck, slideIndices, signal) {
  const html = renderDeckDocument(deck, slideIndices);
  return withPptPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    return page.evaluate(({ slideW, slideH }) => {
      const INLINE_TAGS = new Set(['SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SMALL', 'CODE', 'BR']);
      const slides = [...document.querySelectorAll('section.ppt-slide')];
      const errors = [];
      const warnings = [];
      const summary = [];

      const textPreview = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const isVisible = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0.5 && rect.height > 0.5;
      };

      for (const slideEl of slides) {
        const index = Number(slideEl.dataset.slideIndex);
        const base = slideEl.getBoundingClientRect();
        const slideErrors = [];
        const slideWarnings = [];

        // 1. 画布整体溢出检查
        const overflowY = Math.round(slideEl.scrollHeight - slideH);
        const overflowX = Math.round(slideEl.scrollWidth - slideW);
        if (overflowY > 2) {
          slideErrors.push({
            slide: index,
            type: 'canvas_overflow',
            message: `第 ${index} 页内容垂直溢出画布 ${overflowY}px，请精简文案、压缩间距或拆分页面。`
          });
        }
        if (overflowX > 2) {
          slideErrors.push({
            slide: index,
            type: 'canvas_overflow',
            message: `第 ${index} 页内容水平溢出画布 ${overflowX}px，请调整列宽或网格布局。`
          });
        }

        const textBoxes = [];
        let totalChars = 0;

        // 2. 遍历可见子元素检查裁剪、越界、字号与文本块
        const walker = document.createTreeWalker(slideEl, NodeFilter.SHOW_ELEMENT);
        let node;
        while ((node = walker.nextNode())) {
          const el = node;
          if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
          if (!isVisible(el)) continue;

          const style = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const rel = {
            left: r.left - base.left,
            top: r.top - base.top,
            right: r.right - base.left,
            bottom: r.bottom - base.top,
            width: r.width,
            height: r.height
          };

          // 检查是否超出 1280x720 画布边界（允许 2px 亚像素误差）
          if (rel.left < -2 || rel.top < -2 || rel.right > slideW + 2 || rel.bottom > slideH + 2) {
            const label = textPreview(el) || el.tagName.toLowerCase();
            slideErrors.push({
              slide: index,
              type: 'out_of_bounds',
              element: label,
              message: `第 ${index} 页元素「${label}」超出 1280x720 画布边界（位置 ${Math.round(rel.left)},${Math.round(rel.top)} 到 ${Math.round(rel.right)},${Math.round(rel.bottom)}）。`
            });
          }

          // 检查容器内部文本或内容被 overflow:hidden 截断
          if (el.tagName.toLowerCase() !== 'svg' && el.clientHeight > 0 && el.clientWidth > 0) {
            const clippedY = Math.round(el.scrollHeight - el.clientHeight);
            const clippedX = Math.round(el.scrollWidth - el.clientWidth);
            const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip' || style.overflowY === 'auto' || style.overflowY === 'scroll';
            const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip' || style.overflowX === 'auto' || style.overflowX === 'scroll';
            if ((clipsY && clippedY > 5) || (clipsX && clippedX > 5)) {
              const label = textPreview(el) || el.tagName.toLowerCase();
              slideErrors.push({
                slide: index,
                type: 'element_overflow',
                element: label,
                message: `第 ${index} 页元素「${label}」内容被裁切（水平溢出 ${Math.max(0, clippedX)}px，垂直溢出 ${Math.max(0, clippedY)}px）。`
              });
            }
          }

          // 判断是否为文本叶子块
          if (el.tagName.toLowerCase() === 'svg' || el.tagName === 'TABLE' || el.tagName === 'THEAD' || el.tagName === 'TBODY' || el.tagName === 'TR') {
            continue;
          }
          const childElements = [...el.children];
          const hasDirectText = [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
          const hasBlockChild = childElements.some(child => !INLINE_TAGS.has(child.tagName));

          if (hasDirectText && hasBlockChild) {
            slideWarnings.push({
              slide: index,
              type: 'bare_text_node',
              message: `第 ${index} 页存在裸文本与块级子元素混排（「${textPreview(el)}」），建议将文本放入独立的 <p> 或 <span> 中。`
            });
          }

          const isLeafText = !hasBlockChild && (el.innerText || '').trim().length > 0 && !el.closest('table');
          const parentIsLeaf = el.parentElement && el.parentElement !== slideEl && INLINE_TAGS.has(el.tagName);
          if (isLeafText && !parentIsLeaf) {
            const text = (el.innerText || '').trim();
            totalChars += text.length;
            const fontSize = parseFloat(style.fontSize);
            const inFooterOrBadge = Boolean(el.closest('.ppt-footer, .ppt-kicker, .ppt-badge')) || rel.top >= slideH - 72;
            const isBodyParagraph = !inFooterOrBadge && (el.tagName === 'P' || el.tagName === 'LI' || text.length >= 14);
            if (fontSize > 0 && fontSize < 13) {
              slideErrors.push({
                slide: index,
                type: 'font_too_small',
                element: text.slice(0, 30),
                message: `第 ${index} 页文字「${text.slice(0, 30)}」字号仅 ${Math.round(fontSize)}px（导出约 ${Math.round(fontSize * 0.75)}pt），小于 13px 最低可读标准。`
              });
            } else if (isBodyParagraph && fontSize > 0 && fontSize < 17) {
              slideErrors.push({
                slide: index,
                type: 'font_too_small',
                element: text.slice(0, 30),
                message: `第 ${index} 页正文段落「${text.slice(0, 30)}」字号仅 ${Math.round(fontSize)}px（导出约 ${Math.round(fontSize * 0.75)}pt），在 PPT 中偏小且与标题比例失调，请调整为 18-20px。`
              });
            }
            textBoxes.push({ el, rect: rel, label: text.slice(0, 24) });
          }
        }

        // 3. 检查同页独立文本块之间是否相互遮挡重叠
        for (let i = 0; i < textBoxes.length; i++) {
          for (let j = i + 1; j < textBoxes.length; j++) {
            const a = textBoxes[i];
            const b = textBoxes[j];
            if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
            const ix = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const iy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            if (ix > 8 && iy > 8) {
              const interArea = ix * iy;
              const minArea = Math.min(a.rect.width * a.rect.height, b.rect.width * b.rect.height);
              if (minArea > 0 && interArea / minArea > 0.18) {
                slideErrors.push({
                  slide: index,
                  type: 'text_overlap',
                  message: `第 ${index} 页文本「${a.label}」与「${b.label}」发生重叠，请检查定位和间距。`
                });
              }
            }
          }
        }

        if (totalChars > 460) {
          slideWarnings.push({
            slide: index,
            type: 'high_density',
            message: `第 ${index} 页正文约 ${totalChars} 字，信息密度偏高，建议提炼要点以保持 PPT 留白与可读性。`
          });
        }

        // 每页最多保留前 8 条错误，避免返回体过大
        errors.push(...slideErrors.slice(0, 8));
        warnings.push(...slideWarnings.slice(0, 5));
        summary.push({
          slide: index,
          ok: slideErrors.length === 0,
          chars: totalChars,
          errorCount: slideErrors.length,
          warningCount: slideWarnings.length
        });
      }

      return { ok: errors.length === 0, slides: summary, errors, warnings };
    }, { slideW: SLIDE_WIDTH, slideH: SLIDE_HEIGHT });
  }, { deviceScaleFactor: 1, signal });
}

// 解析 rgba/rgb 颜色为 6 位十六进制与透明度（0-100，0 表示完全不透明）
function parseCssColor(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!match) return null;
  const r = Math.max(0, Math.min(255, Math.round(Number(match[1]))));
  const g = Math.max(0, Math.min(255, Math.round(Number(match[2]))));
  const b = Math.max(0, Math.min(255, Math.round(Number(match[3]))));
  const a = match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4])));
  if (a <= 0.01) return null;
  const hex = [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const transparency = Math.round((1 - a) * 100);
  return { hex, alpha: a, transparency };
}

function parseBoxShadow(raw) {
  if (!raw || raw === 'none') return null;
  const colorMatch = raw.match(/rgba?\([^)]+\)/i);
  const color = colorMatch ? parseCssColor(colorMatch[0]) : { hex: '000000', alpha: 0.16, transparency: 84 };
  if (!color) return null;
  const numbers = raw.replace(/rgba?\([^)]+\)/ig, '').match(/-?[\d.]+px/g)?.map(v => parseFloat(v)) ?? [];
  if (numbers.length < 2) return null;
  const [ox = 0, oy = 4, blur = 12] = numbers;
  const distPx = Math.hypot(ox, oy);
  const angle = Math.round(((Math.atan2(oy, ox) * 180) / Math.PI + 360) % 360);
  return {
    type: 'outer',
    color: color.hex,
    opacity: Math.max(0.05, Math.min(1, color.alpha)),
    blur: Math.max(0, Math.min(40, Math.round(blur * 0.75))),
    offset: Math.max(0, Math.min(30, Math.round(distPx * 0.75))),
    angle
  };
}

// 导出高保真可编辑 PPTX：浏览器测量坐标与样式 + 复杂 SVG/渐变元素 2x 栅格 + 原生文本框/形状/表格
export async function exportDeckToPptx(deck, signal) {
  const html = renderDeckDocument(deck);
  const pptx = new PptxGenJS();
  pptx.author = '建站工作台';
  pptx.title = deck.title;
  pptx.defineLayout({ name: 'SLIDE_16_9', width: SLIDE_W_IN, height: SLIDE_H_IN });
  pptx.layout = 'SLIDE_16_9';
  const slideAnimSpecs = [];

  await withPptPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);

    const slideCount = await page.locator('section.ppt-slide').count();
    for (let sIdx = 0; sIdx < slideCount; sIdx++) {
      signal?.throwIfAborted();
      const slideLocator = page.locator('section.ppt-slide').nth(sIdx);
      const slideMeta = deck.slides[sIdx];
      const pptxSlide = pptx.addSlide();
      const slideAnims = [];
      let elSeq = 1;
      slideAnimSpecs.push({
        transition: slideMeta?.transition || 'none',
        animations: slideAnims
      });

      // 1. 提取整页背景及按渲染顺序排列的 DOM 操作指令
      const extracted = await slideLocator.evaluate((slideEl) => {
        const INLINE_TAGS = new Set(['SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'SMALL', 'CODE', 'BR']);
        const base = slideEl.getBoundingClientRect();
        const rootStyle = getComputedStyle(slideEl);
        let opCounter = 0;
        const ops = [];

        const isVisible = (el) => {
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          return r.width > 0.5 && r.height > 0.5;
        };

        const relRect = (el) => {
          const r = el.getBoundingClientRect();
          return {
            x: r.left - base.left,
            y: r.top - base.top,
            w: r.width,
            h: r.height
          };
        };

        const extractRuns = (container) => {
          const runs = [];
          const walkText = (node, styleEl) => {
            if (node.nodeType === Node.TEXT_NODE) {
              const rawText = node.textContent.replace(/\s+/g, ' ');
              if (!rawText) return;
              const st = getComputedStyle(styleEl);
              const weight = Number(st.fontWeight) || (st.fontWeight === 'bold' ? 700 : 400);
              runs.push({
                text: rawText,
                color: st.color,
                fontSize: parseFloat(st.fontSize) || 16,
                fontFamily: st.fontFamily,
                bold: weight >= 600,
                italic: st.fontStyle === 'italic',
                underline: st.textDecorationLine.includes('underline'),
                strike: st.textDecorationLine.includes('line-through')
              });
              return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.tagName === 'BR') {
              runs.push({ text: '\n', isBreak: true });
              return;
            }
            const childStyle = getComputedStyle(node);
            if (childStyle.display === 'none' || childStyle.visibility === 'hidden') return;
            for (const child of node.childNodes) walkText(child, node);
          };
          walkText(container, container);
          // 清理首尾空白
          if (runs.length && !runs[0].isBreak) runs[0].text = runs[0].text.replace(/^\s+/, '');
          if (runs.length && !runs[runs.length - 1].isBreak) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
          return runs.filter(r => r.isBreak || r.text.length > 0);
        };

        const visit = (el, inheritedAnim = null) => {
          if (!isVisible(el)) return;
          const tag = el.tagName.toLowerCase();
          const st = getComputedStyle(el);
          const rect = relRect(el);
          const ownAnim = el.getAttribute('data-anim');
          const activeAnim = ownAnim
            ? {
                anim: ownAnim,
                order: Math.max(1, Math.min(20, Number.parseInt(el.getAttribute('data-anim-order') || '1', 10) || 1)),
                trigger: el.getAttribute('data-anim-trigger') === 'click' ? 'click' : 'auto'
              }
            : inheritedAnim;

          // 1) SVG 或显式要求栅格化的复杂视觉元素
          if (tag === 'svg' || el.getAttribute('data-rasterize') === 'true') {
            const opId = `op-${opCounter++}`;
            el.setAttribute('data-ppt-op', opId);
            ops.push({ kind: 'raster', opId, rect, anim: activeAnim });
            return;
          }

          // 2) 原生表格
          if (tag === 'table') {
            const trEls = [...el.querySelectorAll('tr')];
            const rows = [];
            const colWidths = [];
            const rowHeights = [];
            for (let rIdx = 0; rIdx < trEls.length; rIdx++) {
              const tr = trEls[rIdx];
              const trRect = tr.getBoundingClientRect();
              rowHeights.push(trRect.height);
              const cellEls = [...tr.children].filter(c => c.tagName === 'TH' || c.tagName === 'TD');
              const row = [];
              for (let cIdx = 0; cIdx < cellEls.length; cIdx++) {
                const cell = cellEls[cIdx];
                const cst = getComputedStyle(cell);
                const cr = cell.getBoundingClientRect();
                if (rIdx === 0) colWidths.push(cr.width);
                row.push({
                  runs: extractRuns(cell),
                  fill: cst.backgroundColor,
                  borderColor: cst.borderBottomColor || cst.borderColor,
                  borderWidth: parseFloat(cst.borderBottomWidth) || 0,
                  align: cst.textAlign,
                  colspan: Number(cell.getAttribute('colspan')) || 1,
                  rowspan: Number(cell.getAttribute('rowspan')) || 1
                });
              }
              if (row.length) rows.push(row);
            }
            if (rows.length) {
              ops.push({ kind: 'table', rect, rows, colWidths, rowHeights, anim: activeAnim });
            }
            return;
          }

          // 3) 分隔线 hr
          if (tag === 'hr') {
            ops.push({
              kind: 'shape',
              rect: { x: rect.x, y: rect.y, w: rect.w, h: Math.max(1.5, rect.h) },
              fill: st.borderTopColor || st.backgroundColor,
              borderColor: null,
              borderWidth: 0,
              borderRadius: 0,
              shadow: 'none',
              anim: activeAnim
            });
            return;
          }

          // 4) 元素自身背景/边框（形状、单边分割线或渐变底图）
          const hasGradient = st.backgroundImage && st.backgroundImage !== 'none';
          const bg = st.backgroundColor;
          const bt = st.borderTopStyle !== 'none' ? (parseFloat(st.borderTopWidth) || 0) : 0;
          const br = st.borderRightStyle !== 'none' ? (parseFloat(st.borderRightWidth) || 0) : 0;
          const bb = st.borderBottomStyle !== 'none' ? (parseFloat(st.borderBottomWidth) || 0) : 0;
          const bl = st.borderLeftStyle !== 'none' ? (parseFloat(st.borderLeftWidth) || 0) : 0;
          const allFourBorders = bt > 0 && br > 0 && bb > 0 && bl > 0 &&
            Math.abs(bt - br) < 0.5 && Math.abs(bt - bb) < 0.5 && Math.abs(bt - bl) < 0.5 &&
            st.borderTopColor === st.borderRightColor && st.borderTopColor === st.borderBottomColor && st.borderTopColor === st.borderLeftColor;
          const radius = parseFloat(st.borderTopLeftRadius) || 0;
          const hasVisibleFill = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';

          if (hasGradient) {
            const opId = `op-${opCounter++}`;
            el.setAttribute('data-ppt-op', opId);
            ops.push({ kind: 'gradient_box', opId, rect, anim: activeAnim });
          } else if (hasVisibleFill || allFourBorders) {
            ops.push({
              kind: 'shape',
              rect,
              fill: hasVisibleFill ? bg : null,
              borderColor: allFourBorders ? st.borderTopColor : null,
              borderWidth: allFourBorders ? bt : 0,
              borderRadius: radius,
              shadow: st.boxShadow,
              anim: activeAnim
            });
          }

          // 单边或非对称边框（例如 .ppt-footer 的 border-top、左侧色条 border-left）拆成独立细线，避免导出成四边框
          if (!allFourBorders && !hasGradient) {
            if (bt > 0) ops.push({ kind: 'shape', rect: { x: rect.x, y: rect.y, w: rect.w, h: Math.max(1, bt) }, fill: st.borderTopColor, borderColor: null, borderWidth: 0, borderRadius: 0, shadow: 'none', anim: activeAnim });
            if (bb > 0) ops.push({ kind: 'shape', rect: { x: rect.x, y: rect.y + rect.h - Math.max(1, bb), w: rect.w, h: Math.max(1, bb) }, fill: st.borderBottomColor, borderColor: null, borderWidth: 0, borderRadius: 0, shadow: 'none', anim: activeAnim });
            if (bl > 0) ops.push({ kind: 'shape', rect: { x: rect.x, y: rect.y, w: Math.max(1, bl), h: rect.h }, fill: st.borderLeftColor, borderColor: null, borderWidth: 0, borderRadius: 0, shadow: 'none', anim: activeAnim });
            if (br > 0) ops.push({ kind: 'shape', rect: { x: rect.x + rect.w - Math.max(1, br), y: rect.y, w: Math.max(1, br), h: rect.h }, fill: st.borderRightColor, borderColor: null, borderWidth: 0, borderRadius: 0, shadow: 'none', anim: activeAnim });
          }

          // 5) 判断是否为文本叶子块
          const childElements = [...el.children];
          const hasBlockChild = childElements.some(child => !INLINE_TAGS.has(child.tagName));
          const plainText = (el.innerText || '').trim();

          if (!hasBlockChild && plainText.length > 0) {
            const runs = extractRuns(el);
            if (runs.length) {
              const padL = parseFloat(st.paddingLeft) || 0;
              const padR = parseFloat(st.paddingRight) || 0;
              const padT = parseFloat(st.paddingTop) || 0;
              const padB = parseFloat(st.paddingBottom) || 0;
              const fontSize = parseFloat(st.fontSize) || 16;
              const lineHeightPx = parseFloat(st.lineHeight);
              const lineSpacingMultiple = Number.isFinite(lineHeightPx) && fontSize > 0
                ? Math.max(1, Math.min(2.2, lineHeightPx / fontSize))
                : 1.25;
              const parentTag = el.parentElement?.tagName;
              const bullet = tag === 'li' ? (parentTag === 'OL' ? 'number' : 'bullet') : null;

              // 综合 text-align 与 Flex/Grid 对齐，准确还原圆形序号、徽章、居中标题等水平与垂直居中
              const isFlex = st.display.includes('flex');
              const isGrid = st.display.includes('grid');
              const isCol = isFlex && st.flexDirection.startsWith('column');
              const textRange = document.createRange();
              textRange.selectNodeContents(el);
              const textRect = textRange.getBoundingClientRect();
              const isSingleLine = !plainText.includes('\n') && textRect.height > 0 && textRect.height <= fontSize * 1.75;

              let resolvedAlign = st.textAlign === 'center' ? 'center' : (st.textAlign === 'right' || st.textAlign === 'end') ? 'right' : 'left';
              if (isFlex) {
                const hAxis = isCol ? st.alignItems : st.justifyContent;
                if (hAxis === 'center') resolvedAlign = 'center';
                else if (hAxis === 'flex-end' || hAxis === 'end' || hAxis === 'right') resolvedAlign = 'right';
              } else if (isGrid) {
                if (st.justifyItems === 'center' || st.justifyContent === 'center') resolvedAlign = 'center';
                else if (st.justifyItems === 'end' || st.justifyContent === 'end') resolvedAlign = 'right';
              } else if (st.display === 'inline-block' && isSingleLine && padL >= 4 && Math.abs(padL - padR) <= 1) {
                resolvedAlign = 'center';
              }

              let resolvedValign = 'top';
              const innerH = Math.max(12, rect.h - padT - padB);
              if (isFlex) {
                const vAxis = isCol ? st.justifyContent : st.alignItems;
                if (vAxis === 'center') resolvedValign = 'middle';
                else if (vAxis === 'flex-end' || vAxis === 'end') resolvedValign = 'bottom';
              } else if (isGrid) {
                if (st.alignItems === 'center' || st.alignContent === 'center') resolvedValign = 'middle';
                else if (st.alignItems === 'end' || st.alignContent === 'end') resolvedValign = 'bottom';
              } else if (isSingleLine && ((Number.isFinite(lineHeightPx) && Math.abs(lineHeightPx - innerH) <= 3) || (st.display === 'inline-block' && padT >= 2 && Math.abs(padT - padB) <= 1))) {
                resolvedValign = 'middle';
              }

              ops.push({
                kind: 'text',
                rect: {
                  x: rect.x + padL,
                  y: rect.y + padT,
                  w: Math.max(12, rect.w - padL - padR),
                  h: innerH
                },
                runs,
                align: resolvedAlign,
                valign: resolvedValign,
                fontSize,
                lineSpacingMultiple: isSingleLine ? null : lineSpacingMultiple,
                bullet,
                anim: activeAnim
              });
            }
            return;
          }

          // 6) 若存在直接文本节点与块级子元素混排，单独提取该文本节点的 Range 矩形
          for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE && child.textContent.trim()) {
              const range = document.createRange();
              range.selectNodeContents(child);
              const rr = range.getBoundingClientRect();
              if (rr.width > 1 && rr.height > 1) {
                const weight = Number(st.fontWeight) || (st.fontWeight === 'bold' ? 700 : 400);
                ops.push({
                  kind: 'text',
                  rect: { x: rr.left - base.left, y: rr.top - base.top, w: rr.width, h: rr.height },
                  runs: [{
                    text: child.textContent.trim(),
                    color: st.color,
                    fontSize: parseFloat(st.fontSize) || 16,
                    fontFamily: st.fontFamily,
                    bold: weight >= 600,
                    italic: st.fontStyle === 'italic',
                    underline: false,
                    strike: false
                  }],
                  align: st.textAlign,
                  fontSize: parseFloat(st.fontSize) || 16,
                  lineSpacingMultiple: 1.25,
                  bullet: null,
                  anim: activeAnim
                });
              }
            } else if (child.nodeType === Node.ELEMENT_NODE) {
              visit(child, activeAnim);
            }
          }
        };

        for (const child of slideEl.children) visit(child, null);

        return {
          rootBgColor: rootStyle.backgroundColor,
          rootHasGradient: Boolean(rootStyle.backgroundImage && rootStyle.backgroundImage !== 'none'),
          ops
        };
      });

      // 2. 写入整页背景
      if (extracted.rootHasGradient) {
        await slideLocator.evaluate((el) => el.classList.add('ppt-export-bg-only'));
        const bgBuf = await slideLocator.screenshot({ type: 'png' });
        await slideLocator.evaluate((el) => el.classList.remove('ppt-export-bg-only'));
        pptxSlide.background = { data: 'image/png;base64,' + bgBuf.toString('base64') };
      } else {
        const rootColor = parseCssColor(extracted.rootBgColor);
        pptxSlide.background = { color: rootColor?.hex ?? 'FFFFFF' };
      }

      // 3. 按顺序写入原生对象或局部 2x 栅格图，并记录需要绑定动画的对象名称
      const bindAnim = (op) => {
        const objectName = `ppt-el-${elSeq++}`;
        if (op.anim) slideAnims.push({ objectName, ...op.anim });
        return objectName;
      };

      for (const op of extracted.ops) {
        if (op.rect.w <= 0.5 || op.rect.h <= 0.5) continue;

        if (op.kind === 'raster') {
          const target = slideLocator.locator(`[data-ppt-op="${op.opId}"]`);
          const png = await target.screenshot({ type: 'png', omitBackground: true });
          pptxSlide.addImage({
            data: 'image/png;base64,' + png.toString('base64'),
            x: pxToIn(op.rect.x),
            y: pxToIn(op.rect.y),
            w: pxToIn(op.rect.w),
            h: pxToIn(op.rect.h),
            objectName: bindAnim(op)
          });
          continue;
        }

        if (op.kind === 'gradient_box') {
          const target = slideLocator.locator(`[data-ppt-op="${op.opId}"]`);
          await target.evaluate((el) => el.classList.add('ppt-export-bg-only'));
          const png = await target.screenshot({ type: 'png', omitBackground: true });
          await target.evaluate((el) => el.classList.remove('ppt-export-bg-only'));
          pptxSlide.addImage({
            data: 'image/png;base64,' + png.toString('base64'),
            x: pxToIn(op.rect.x),
            y: pxToIn(op.rect.y),
            w: pxToIn(op.rect.w),
            h: pxToIn(op.rect.h),
            objectName: bindAnim(op)
          });
          continue;
        }

        if (op.kind === 'shape') {
          const fill = parseCssColor(op.fill);
          const border = parseCssColor(op.borderColor);
          if (!fill && !border) continue;
          const minSide = Math.min(op.rect.w, op.rect.h);
          const isCircle = op.borderRadius >= minSide / 2 - 1 && Math.abs(op.rect.w - op.rect.h) <= 4;
          const shapeType = isCircle
            ? pptx.ShapeType.ellipse
            : op.borderRadius > 2
              ? pptx.ShapeType.roundRect
              : pptx.ShapeType.rect;
          const shapeOpts = {
            x: pxToIn(op.rect.x),
            y: pxToIn(op.rect.y),
            w: pxToIn(op.rect.w),
            h: pxToIn(op.rect.h),
            objectName: bindAnim(op)
          };
          if (fill) {
            shapeOpts.fill = { color: fill.hex, ...(fill.transparency > 0 && { transparency: fill.transparency }) };
          } else {
            shapeOpts.fill = { type: 'none' };
          }
          if (border && op.borderWidth > 0) {
            shapeOpts.line = {
              color: border.hex,
              width: Math.max(0.5, pxToPt(op.borderWidth)),
              ...(border.transparency > 0 && { transparency: border.transparency })
            };
          } else {
            shapeOpts.line = { type: 'none' };
          }
          if (shapeType === pptx.ShapeType.roundRect) {
            shapeOpts.rectRadius = Math.max(0.02, Math.min(0.5, op.borderRadius / minSide));
          }
          const shadow = parseBoxShadow(op.shadow);
          if (shadow) shapeOpts.shadow = shadow;
          pptxSlide.addShape(shapeType, shapeOpts);
          continue;
        }

        if (op.kind === 'table') {
          const tableRows = op.rows.map((row) => row.map((cell) => {
            const fill = parseCssColor(cell.fill);
            const border = parseCssColor(cell.borderColor);
            const align = cell.align === 'center' ? 'center' : cell.align === 'right' ? 'right' : 'left';
            const runs = cell.runs.map((run) => {
              if (run.isBreak) return { text: '', options: { breakLine: true } };
              const c = parseCssColor(run.color);
              return {
                text: run.text,
                options: {
                  fontFace: pickFontFace(run.fontFamily),
                  fontSize: Math.max(9, pxToPt(run.fontSize)),
                  color: c?.hex ?? '1F2937',
                  bold: run.bold,
                  italic: run.italic,
                  underline: run.underline ? { style: 'sng' } : undefined
                }
              };
            });
            return {
              text: runs.length ? runs : '',
              options: {
                align,
                valign: 'middle',
                colspan: cell.colspan > 1 ? cell.colspan : undefined,
                rowspan: cell.rowspan > 1 ? cell.rowspan : undefined,
                fill: fill ? { color: fill.hex, ...(fill.transparency > 0 && { transparency: fill.transparency }) } : undefined,
                border: border && cell.borderWidth > 0
                  ? { pt: Math.max(0.5, pxToPt(cell.borderWidth)), color: border.hex }
                  : { pt: 0.5, color: 'DCE3EE' },
                margin: [4, 8, 4, 8]
              }
            };
          }));
          pptxSlide.addTable(tableRows, {
            x: pxToIn(op.rect.x),
            y: pxToIn(op.rect.y),
            w: pxToIn(op.rect.w),
            colW: op.colWidths.length ? op.colWidths.map(pxToIn) : undefined,
            rowH: op.rowHeights.length ? op.rowHeights.map(pxToIn) : undefined,
            autoPage: false,
            objectName: bindAnim(op)
          });
          continue;
        }

        if (op.kind === 'text') {
          const align = op.align === 'center' ? 'center' : op.align === 'right' ? 'right' : 'left';
          const valign = op.valign === 'middle' ? 'middle' : op.valign === 'bottom' ? 'bottom' : 'top';
          const textRuns = op.runs.map((run) => {
            if (run.isBreak) return { text: '', options: { breakLine: true } };
            const c = parseCssColor(run.color);
            return {
              text: run.text,
              options: {
                fontFace: pickFontFace(run.fontFamily),
                fontSize: Math.max(9, pxToPt(run.fontSize)),
                color: c?.hex ?? '1F2937',
                bold: run.bold,
                italic: run.italic,
                underline: run.underline ? { style: 'sng' } : undefined,
                strike: run.strike ? 'sngStrike' : undefined
              }
            };
          });
          // PowerPoint/WPS 渲染中文字体略宽于 Chromium：居中文本向两侧对称扩展，右对齐向左扩展，左对齐向右扩展
          const bulletShift = op.bullet ? Math.min(18, op.rect.x) : 0;
          const basePad = Math.min(24, op.rect.w * 0.04 + 4);
          let boxX = op.rect.x - bulletShift;
          let boxW = op.rect.w + basePad + bulletShift;
          if (align === 'center' && !op.bullet) {
            const half = basePad / 2;
            boxX = Math.max(0, op.rect.x - half);
            boxW = op.rect.w + basePad;
          } else if (align === 'right' && !op.bullet) {
            boxX = Math.max(0, op.rect.x - basePad);
            boxW = op.rect.w + basePad;
          }
          const adjustedW = Math.min(SLIDE_WIDTH - boxX - 2, boxW);
          const adjustedH = valign === 'middle'
            ? op.rect.h
            : Math.min(SLIDE_HEIGHT - op.rect.y - 2, op.rect.h + 6);
          const textOpts = {
            x: pxToIn(boxX),
            y: pxToIn(op.rect.y),
            w: pxToIn(Math.max(12, adjustedW)),
            h: pxToIn(Math.max(12, adjustedH)),
            align,
            valign,
            margin: 0,
            wrap: true,
            ...(op.lineSpacingMultiple ? { lineSpacingMultiple: op.lineSpacingMultiple } : {}),
            objectName: bindAnim(op)
          };
          if (op.bullet === 'bullet') textOpts.bullet = { indent: 14 };
          else if (op.bullet === 'number') textOpts.bullet = { type: 'number', indent: 14 };
          pptxSlide.addText(textRuns, textOpts);
        }
      }

      if (slideMeta?.notes) {
        pptxSlide.addNotes(slideMeta.notes);
      }
    }
  }, { deviceScaleFactor: 2, signal });

  const buffer = Buffer.from(await pptx.write({ outputType: 'nodebuffer' }));
  return applyPptxAnimations(buffer, slideAnimSpecs);
}

// 导出 100% 像素一致的 16:9 PDF
export async function exportDeckToPdf(deck, signal) {
  const html = renderDeckDocument(deck);
  return withPptPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts?.ready);
    const pdf = await page.pdf({
      width: `${SLIDE_WIDTH}px`,
      height: `${SLIDE_HEIGHT}px`,
      printBackground: true,
      margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
    });
    return Buffer.from(pdf);
  }, { deviceScaleFactor: 2, signal });
}
