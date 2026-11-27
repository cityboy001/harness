import { createHash } from 'node:crypto';
import { PublicError } from './models.mjs';
import { runReAct } from './react-agent.mjs';
import { createWebResearchTools } from './web-research.mjs';
import { DEFAULT_PPT_THEME, MAX_SLIDES, normalizeDeck, normalizeSlide, normalizeTheme, VALID_LAYOUTS, VALID_TRANSITIONS } from './ppt-deck.mjs';
import { inspectDeckInBrowser } from './ppt-export.mjs';
import { attachmentToolLimit, createAttachmentContext } from './attachments.mjs';

const deckDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function quickPptReply(prompt) {
  const text = prompt.trim().replace(/[\s，。！!？?、~～]+$/gu, '');
  if (/^(?:你好(?:呀|啊|哇|哈)?|您好|哈喽|嗨|hello|hi|hey)$/iu.test(text)) {
    return '你好！告诉我演示主题、受众、页数或想修改哪一页，我会先做好排版检查再输出可预览、可编辑、可导出的 PPT。';
  }
  if (/^(?:谢谢(?:你|啦|啊)?|多谢|感谢|thanks|thank you)$/iu.test(text)) return '不客气！';
  if (/^(?:好的|收到|知道了|明白了|ok)$/iu.test(text)) return '好的。';
}

const pptTools = [
  {
    type: 'function',
    function: {
      name: 'set_deck_theme',
      description: '设定整份 PPT 的标题与全局视觉主题色板。新建 PPT 时应先调用一次，确保全套幻灯片视觉统一。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '演示文稿总标题' },
          theme: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '主题风格名称，如 深海商务、森林自然、暖陶质感、科技青蓝' },
              primary: { type: 'string', description: '主色 #RRGGBB（占 60-70% 视觉权重，用于深色封面底色与重点标题）' },
              secondary: { type: 'string', description: '浅色内容页背景 #RRGGBB（如 #F4F6FA 或 #F7F5F0）' },
              surface: { type: 'string', description: '卡片底色 #RRGGBB（通常为 #FFFFFF）' },
              accent: { type: 'string', description: '强调色 #RRGGBB（用于关键数字、徽章、重点边框、图表高亮）' },
              text: { type: 'string', description: '浅底主文字色 #RRGGBB（如 #1F2937）' },
              muted: { type: 'string', description: '浅底辅助文字色 #RRGGBB（如 #64748B）' },
              onPrimary: { type: 'string', description: '深底文字色 #RRGGBB（通常为 #FFFFFF）' }
            },
            additionalProperties: false
          }
        },
        required: ['title', 'theme'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upsert_slide',
      description: '新增或更新指定页码的 1280x720 幻灯片 HTML。支持逐页创建，或在修改现有 PPT 时只更新指定页面。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 1, maximum: MAX_SLIDES, description: '页码（从 1 开始；等于当前总页数+1 表示追加新页）' },
          title: { type: 'string', description: '该页核心标题（用于大纲目录）' },
          layout: {
            type: 'string',
            enum: [...VALID_LAYOUTS],
            description: '版式类型：cover/section/split/metrics/cards/comparison/timeline/table/chart/closing/custom'
          },
          tone: { type: 'string', enum: ['dark', 'light'], description: '页面基调：封面/章节过渡/结尾常用 dark，正文常用 light' },
          transition: {
            type: 'string',
            enum: [...VALID_TRANSITIONS],
            description: '页间切换动画：fade（淡入淡出，默认）/ push（推入）/ wipe（擦除）/ zoom（缩放）/ none（无）'
          },
          html: { type: 'string', description: '放进 1280x720 幻灯片容器内的 HTML 片段（不含外层 html/body/script/style）' },
          notes: { type: 'string', description: '可选的演讲者备注，导出 PPTX 时自动写入备注栏' }
        },
        required: ['index', 'title', 'layout', 'tone', 'html'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_slide',
      description: '删除一个或多个指定页码的幻灯片，后续页面自动顺延重排页码。删除多页时请直接传 indices 数组一次完成。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 1, maximum: MAX_SLIDES, description: '要删除的单个页码（从 1 开始）' },
          indices: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: MAX_SLIDES },
            description: '批量删除多个页码列表（如 [4, 5, 6, 7]），内部自动从大到小删除'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_slides',
      description: '在真实 1280x720 浏览器中渲染当前所有幻灯片，检查溢出、越界、文字重叠、过小字号与排版密度。交付 PPT 前必须调用并通过全部检查，拿到 deckId 后才能结束。',
      parameters: {
        type: 'object',
        properties: {
          slideIndices: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: MAX_SLIDES },
            description: '可选：局部复查指定页码；最终交付前请省略以全量检查并获取 deckId'
          }
        },
        additionalProperties: false
      }
    }
  }
];

const pptSystemPrompt = `你是专业 PPT 演示文稿设计与制作 Agent。你的产出会在右侧 16:9 画布直接在线预览、原地编辑文字，并高保真导出为可编辑 .pptx 和 .pdf。

## 交互原则
1. 普通问答、解释现有 PPT、只讨论大纲思路时，直接用简体中文文字或 {"answer":"..."} 回复，不要修改幻灯片。
2. 当用户要求创建或修改 PPT 时：
   - 新建 PPT：先调用 set_deck_theme 确定符合主题气质的配色，再按页调用 upsert_slide 逐页生成（可在单轮并行调用最多 4 个工具加快速度）。默认 6-10 页，除非用户指定页数。
   - 修改现有 PPT：只调用 upsert_slide / remove_slide / set_deck_theme 修改相关页面，不要无故重写未受影响的页面；删除多页时直接通过一次 remove_slide({ indices: [...] }) 批量删除。
   - **必须先自检再交付**：所有修改完成后，必须调用无参数的 inspect_slides 做真实浏览器 1280x720 排版检查。若返回任何 errors（canvas_overflow、element_overflow、out_of_bounds、text_overlap、font_too_small），必须用 upsert_slide 修复并重新调用 inspect_slides，直到 ok=true 并获得有效 deckId。
   - 最终交付只返回一个 JSON 对象：{"summary":"简短中文总结本次生成或修改要点","deckId":"deck-N"}。

## 精美 PPT 设计规范（必须遵守）
1. **配色与节奏**：
   - 选一套贴合主题的配色，不千篇一律默认蓝（例如：企业战略可用深海蓝 #1E2761 + 青绿 #00A896；环保/ESG 用森林绿 #1B4332 + 苔绿 #52B788；消费/文创用暖陶红 #9B3D2F + 暖米底 #FAF7F2；科技/AI 用深靛 #111827 + 电光青 #0EA5E9）。
   - 采用深浅交替节奏：封面页（cover）、章节过渡页（section）、结尾页（closing）用 tone="dark"；核心内容页用 tone="light"。
2. **版式多样性与留白**：
   - 每页只传达 1 个核心结论，标题直接写结论而非空泛名词。
   - **禁止连续两页都是“标题 + 普通项目符号列表”**！主动混用多种高表现力版式：
     - 封面页：大号主标题（48-56px）+ 副标题（20-24px）+ 顶部标签徽章 + 右侧几何色块或关键信息卡 + 底部汇报人/日期。
     - 指标总览页（metrics）：3-4 张大数字卡片（.ppt-stat 44-52px 大字 + 单位 + 简短说明）。
     - 左右分栏页（split）：左文右图（内联 SVG 图表/流程图/架构图）或左论点右案例卡片。
     - 卡片网格页（cards）：2x2 或 3 列等高卡片，每张卡片含顶部序号/徽章、小标题、2-3 行精炼文案。
     - 对比页（comparison）：双栏对比（现状 vs 目标 / 方案 A vs 方案 B），用主色与强调色区分。
     - 路线图/时间轴页（timeline）：横向 3-5 阶段步骤条或里程碑卡片，带连接线或箭头。
     - 数据表页（table）：原生 <table class="ppt-table">，表头清晰，单元格简洁，附下方核心洞察栏。
     - 图表页（chart）：左侧内联 <svg viewBox="0 0 600 360"> 清晰绘制柱状图/横向条形图/折线图/环形图（务必标清数值和标签），右侧配 2-3 条关键解读卡片。
   - 单页文字保持精炼（建议 70-220 字），四周保留充裕呼吸感，底部可加简洁页眉/页脚与页码。

## 1280x720 画布与 PPTX 导出友好约束（严格遵守，确保所见即所导）
1. 每页外层已经是 1280x720 的 .ppt-slide 容器并注入了主题变量：
   var(--ppt-primary)、var(--ppt-secondary)、var(--ppt-surface)、var(--ppt-accent)、var(--ppt-text)、var(--ppt-muted)、var(--ppt-on-primary)、var(--ppt-border)。
2. 推荐使用内置基础类：.ppt-slide-inner（自带 52px 64px 48px 安全边距和纵向 flex）、.ppt-header、.ppt-kicker、.ppt-subtitle、.ppt-body、.ppt-grid-2、.ppt-grid-3、.ppt-grid-4、.ppt-card、.ppt-stat、.ppt-badge、.ppt-table、.ppt-footer，也可配合干净的内联 style 做精细 Flexbox/Grid 排版。
3. **文字与字号层级规范（1280x720 导出 PPTX 按 0.75 倍换算为 pt，切忌正文偏小或标题与正文比例悬殊）**：
   - 所有可见文字必须放在语义文本标签（h1-h4、p、li、th、td、figcaption、span）内，不要把裸文本与块级 div 混写在同一个父元素里。
   - 严格保持协调的字号层级：封面主标题 h1 为 48-56px；内容页主标题 h2 为 32-36px（约正文的 1.7-1.9 倍，切忌过大导致头重脚轻）；卡片/分节小标题 h3 为 21-24px；**正文段落/列表/卡片说明文字必须为 18-20px**（导出 PPTX 约 13.5-15pt，勿使用内联 style 把正文压小到 14-16px）；表格文字 16-18px；顶部 kicker/徽章/页脚/来源注释 14-15px；全页任何文字严禁小于 13px。
4. **图表与视觉装饰**：用内联 <svg>（指定明确 width/height 或 viewBox 与尺寸）画数据图表、流程箭头、几何图标；不要使用外链 <img>、不要写 <script>/<style> 标签、不要使用 emoji、不要使用 backdrop-filter 或复杂 clip-path。
5. 如需让某个纯视觉装饰块整体高保真转图，可给该容器加 data-rasterize="true"；正文和卡片不要加 data-rasterize，以保持导出的 PPTX 文字 100% 原生可编辑。
6. **动画与切页节奏（同时生效于在线预览放映与导出的原生 PPTX）**：
   - 每页通过 transition 指定切页效果（默认 fade，正文页可酌情用 push，重点转场用 zoom），整份演示保持克制统一。
   - 对核心视觉块（如 .ppt-header、各张 .ppt-card、图表区、表格）添加入场动画属性：
     - data-anim：可选 fade / fade-up / fly-left / fly-right / zoom-in / wipe（推荐以 fade-up 和 fade 为主，图表/指标卡可用 zoom-in）。
     - data-anim-order：整数 1 到 6，控制逐层入场顺序（如标题 1，三张指标卡依次为 2、3、4；不要给每行小字单独加动画，保持大气利落）。
     - data-anim-trigger：默认 auto（切入该页后自动依次出现）；仅在用户明确要求“点击逐步出现”时设为 click。`;

export async function runPptTurn({
  prompt,
  previousDeck,
  recent = [],
  attachments = [],
  completion,
  search,
  read,
  signal,
  maxTokens,
  onProgress,
  onActivity,
  onReasoning
}) {
  const activity = (detail, decision) => {
    onProgress?.(detail);
    return onActivity?.(detail, decision);
  };

  // 工作区当前可变草稿，从上一版 PPT 拷贝开始（若有）
  const draft = previousDeck
    ? {
        templateId: previousDeck.templateId || 'default',
        title: previousDeck.title,
        theme: { ...DEFAULT_PPT_THEME, ...previousDeck.theme },
        slides: previousDeck.slides.map((slide, idx) => ({ ...slide, index: idx + 1 }))
      }
    : {
        templateId: 'default',
        title: '演示文稿',
        theme: { ...DEFAULT_PPT_THEME },
        slides: []
      };

  let mutated = false;
  let toolOps = 0;
  let verifiedCounter = 0;
  let verifiedSnapshot = null; // { id, digest, deck }

  const web = search ? createWebResearchTools({ search, read, signal, onActivity: activity }) : null;
  const attachmentCtx = createAttachmentContext(attachments, { allowTools: true, onActivity: activity });
  const definitions = [
    ...pptTools,
    ...(web ? web.definitions : []),
    ...(attachmentCtx?.toolDefinition ? [attachmentCtx.toolDefinition] : [])
  ];
  const handlers = new Map(web ? web.handlers : []);
  if (attachmentCtx?.toolDefinition) {
    handlers.set(attachmentCtx.toolDefinition.function.name, (args) => attachmentCtx.handler(args));
  }

  handlers.set('set_deck_theme', async ({ title, theme }) => {
    if (typeof title === 'string' && title.trim()) {
      draft.title = title.trim().slice(0, 100);
    }
    draft.theme = normalizeTheme(theme);
    mutated = true;
    toolOps++;
    verifiedSnapshot = null;
    activity(`已设定 PPT 主题：${draft.theme.name}`);
    return JSON.stringify({ ok: true, title: draft.title, theme: draft.theme });
  });

  handlers.set('upsert_slide', async ({ index, title, layout, tone, transition, html, notes }) => {
    if (!Number.isSafeInteger(index) || index < 1 || index > MAX_SLIDES) {
      return JSON.stringify({ ok: false, error: `页码必须在 1 到 ${MAX_SLIDES} 之间。` });
    }
    if (index > draft.slides.length + 1) {
      return JSON.stringify({
        ok: false,
        error: `当前仅有 ${draft.slides.length} 页，请先按顺序创建第 ${draft.slides.length + 1} 页。`
      });
    }
    let slide;
    try {
      slide = normalizeSlide({ title, layout, tone, transition, html, notes }, index);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error.message });
    }
    if (index === draft.slides.length + 1) {
      draft.slides.push(slide);
    } else {
      draft.slides[index - 1] = slide;
    }
    mutated = true;
    toolOps++;
    verifiedSnapshot = null;
    activity(`已编辑第 ${index} 页：${slide.title}`);
    return JSON.stringify({ ok: true, index, totalSlides: draft.slides.length, title: slide.title });
  });

  handlers.set('remove_slide', async ({ index, indices } = {}) => {
    const rawList = Array.isArray(indices) && indices.length
      ? indices
      : (index !== undefined ? [index] : []);
    if (!rawList.length) {
      return JSON.stringify({ ok: false, error: '请提供要删除的页码 index 或 indices 数组。' });
    }
    const unique = [...new Set(rawList)];
    for (const idx of unique) {
      if (!Number.isSafeInteger(idx) || idx < 1 || idx > draft.slides.length) {
        return JSON.stringify({ ok: false, error: `找不到第 ${idx} 页，当前共 ${draft.slides.length} 页。` });
      }
    }
    unique.sort((a, b) => b - a);
    const removedTitles = [];
    for (const idx of unique) {
      const [removed] = draft.slides.splice(idx - 1, 1);
      removedTitles.push(`第 ${idx} 页「${removed.title}」`);
    }
    draft.slides.forEach((slide, idx) => { slide.index = idx + 1; });
    mutated = true;
    toolOps++;
    verifiedSnapshot = null;
    removedTitles.reverse();
    activity(unique.length === 1
      ? `已删除${removedTitles[0]}`
      : `已批量删除 ${unique.length} 页（剩余 ${draft.slides.length} 页）`);
    return JSON.stringify({ ok: true, removed: removedTitles, totalSlides: draft.slides.length });
  });

  handlers.set('inspect_slides', async ({ slideIndices } = {}) => {
    if (!draft.slides.length) {
      return JSON.stringify({ ok: false, error: '当前还没有任何幻灯片，请先调用 upsert_slide 创建页面。' });
    }
    const isFullCheck = !Array.isArray(slideIndices) || slideIndices.length === 0;
    const normalized = normalizeDeck(draft);
    activity(isFullCheck
      ? `正在用浏览器预览检查全部 ${normalized.slides.length} 页排版…`
      : `正在用浏览器复查第 ${slideIndices.join('、')} 页排版…`);
    toolOps++;
    const report = await inspectDeckInBrowser(normalized, isFullCheck ? undefined : slideIndices, signal);
    if (report.ok && isFullCheck) {
      const id = 'deck-' + (++verifiedCounter);
      verifiedSnapshot = { id, digest: deckDigest(normalized), deck: normalized };
      activity(`全部 ${normalized.slides.length} 页排版检查通过`);
      return JSON.stringify({
        ok: true,
        deckId: id,
        slideCount: normalized.slides.length,
        slides: report.slides,
        warnings: report.warnings
      });
    }
    if (!report.ok) {
      activity(`浏览器检查发现 ${report.errors.length} 处排版问题，正在调整…`);
    }
    return JSON.stringify({
      ok: report.ok,
      ...(isFullCheck ? {} : { note: '当前为局部复查，交付前请不传 slideIndices 做一次全量 inspect_slides 以获取 deckId。' }),
      slideCount: normalized.slides.length,
      slides: report.slides,
      errors: report.errors,
      warnings: report.warnings
    });
  });

  const userPayload = previousDeck || recent.length || attachmentCtx
    ? JSON.stringify({
        request: prompt,
        recentDialogue: recent,
        ...(attachmentCtx ? { uploadedAttachments: attachmentCtx.promptText } : {}),
        currentDeck: previousDeck
          ? {
              title: previousDeck.title,
              theme: previousDeck.theme
                ? (({ fontFamily: _ignored, ...rest }) => rest)(previousDeck.theme)
                : undefined,
              slides: previousDeck.slides.map(s => ({
                index: s.index,
                title: s.title,
                layout: s.layout,
                tone: s.tone,
                transition: s.transition,
                notes: s.notes,
                html: s.html
              }))
            }
          : null
      })
    : prompt;

  const messages = [
    { role: 'system', content: pptSystemPrompt + (attachmentCtx ? '\n\n' + attachmentCtx.instructions : '') },
    { role: 'user', content: userPayload }
  ];

  const finishInstructions = '请结束工具调用并直接输出最终 JSON。若已通过全量 inspect_slides 检查并获得 deckId，请返回 {"summary":"简短中文总结","deckId":"对应的deckId"}；若只是回答问题，直接返回 {"answer":"中文回复"}。';

  return runReAct({
    messages,
    definitions,
    handlers,
    completion,
    signal,
    maxTokens,
    maxToolTurns: 24 + (attachmentCtx?.toolDefinition ? attachmentToolLimit : 0),
    maxCallsPerTurn: 12,
    onReasoning,
    progress: () => toolOps + (web?.calls ?? 0) + (attachmentCtx?.calls ?? 0),
    finishInstructions,
    finalize(text) {
      const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/giu, '');
      let parsed = null;
      if (cleaned.startsWith('{')) {
        try { parsed = JSON.parse(cleaned); } catch { /* 下面按格式要求提示模型纠正 */ }
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.deckId === 'string' && parsed.deckId.trim()) {
          if (!draft.slides.length) throw new PublicError(422, '当前没有任何幻灯片可交付。');
          const current = normalizeDeck(draft);
          const currentHash = deckDigest(current);
          if (!verifiedSnapshot || parsed.deckId.trim() !== verifiedSnapshot.id || verifiedSnapshot.digest !== currentHash) {
            throw new PublicError(422, '幻灯片在最近一次浏览器检查后又有改动或尚未通过全量检查，请先调用无参数的 inspect_slides 获取最新 deckId。');
          }
          const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim().slice(0, 4000)
            : `已完成「${current.title}」，共 ${current.slides.length} 页并已通过浏览器排版检查。`;
          return { type: 'ppt', deck: verifiedSnapshot.deck, summary };
        }
        if (typeof parsed.answer === 'string' && parsed.answer.trim()) {
          if (mutated) {
            throw new PublicError(422, '本轮已修改了幻灯片，请先调用无参数的 inspect_slides 通过排版检查，再返回 {"summary":"...","deckId":"..."}。');
          }
          return { type: 'answer', text: parsed.answer.trim().slice(0, 8000) };
        }
      }
      if (mutated) {
        if (verifiedSnapshot) {
          const current = normalizeDeck(draft);
          if (deckDigest(current) === verifiedSnapshot.digest) {
            const summary = cleaned ? cleaned.slice(0, 4000) : `已完成「${current.title}」，共 ${current.slides.length} 页。`;
            return { type: 'ppt', deck: verifiedSnapshot.deck, summary };
          }
        }
        throw new PublicError(422, '本轮已修改了幻灯片但尚未完成全量 inspect_slides 检查，请先调用无参数的 inspect_slides，通过后再返回 {"summary":"...","deckId":"..."}。');
      }
      if (!cleaned) throw new PublicError(422, '对话回复为空，请重试。');
      return { type: 'answer', text: cleaned.slice(0, 8000) };
    },
    correction(error) {
      return {
        kind: 'ppt',
        message: error.message,
        allowTools: true
      };
    },
    recoverVerifiedDraft() {
      if (!verifiedSnapshot) return undefined;
      return {
        type: 'ppt',
        deck: verifiedSnapshot.deck,
        summary: `已完成「${verifiedSnapshot.deck.title}」，共 ${verifiedSnapshot.deck.slides.length} 页（已通过浏览器排版检查）。`
      };
    }
  });
}
