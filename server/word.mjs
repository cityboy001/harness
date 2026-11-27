import { createHash } from 'node:crypto';
import { PublicError } from './models.mjs';
import { runReAct } from './react-agent.mjs';
import { createWebResearchTools } from './web-research.mjs';
import {
  DEFAULT_WORD_THEME,
  MAX_WORD_SECTIONS,
  normalizeWordDoc,
  normalizeWordMeta,
  normalizeWordSection,
  normalizeWordTheme
} from './word-doc.mjs';
import { inspectWordInBrowser } from './word-export.mjs';
import { attachmentToolLimit, createAttachmentContext } from './attachments.mjs';

const docDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function quickWordReply(prompt) {
  const text = prompt.trim().replace(/[\s，。！!？?、~～]+$/gu, '');
  if (/^(?:你好(?:呀|啊|哇|哈)?|您好|哈喽|嗨|hello|hi|hey)$/iu.test(text)) {
    return '你好！告诉我文档主题、用途、读者或想修改哪一章，我会先完成 A4 排版检查再输出可在线预览、编辑并导出 .docx / .pdf 的 Word 文档。';
  }
  if (/^(?:谢谢(?:你|啦|啊)?|多谢|感谢|thanks|thank you)$/iu.test(text)) return '不客气！';
  if (/^(?:好的|收到|知道了|明白了|ok)$/iu.test(text)) return '好的。';
}

const wordTools = [
  {
    type: 'function',
    function: {
      name: 'set_doc_meta',
      description: '设定整份 Word 文档的标题、副标题、封面/目录/页眉页脚开关、封面元信息、主题配色与全局排版样式（字体、字号、行高、段间距、页边距、标题样式、首行缩进、表格紧凑度）。这些样式会同步生效于在线预览、PDF 与导出 .docx。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '文档主标题' },
          subtitle: { type: 'string', description: '可选副标题' },
          headerText: { type: 'string', description: '页眉文字（默认同主标题）' },
          showCover: { type: 'boolean', description: '是否包含独立封面页（正式报告/方案/标书建议 true；合同/通知/一页表单/简历建议 false）' },
          showToc: { type: 'boolean', description: '是否生成目录页（章节数 >= 2 时生效）' },
          showHeaderFooter: { type: 'boolean', description: '导出 Word/PDF 时是否显示页眉和页码页脚（默认 true；单页合同/通知/简历可设为 false）' },
          meta: {
            type: 'object',
            properties: {
              category: { type: 'string', description: '文档类型标签，如 项目方案、研究报告、产品需求文档、制度规范' },
              organization: { type: 'string', description: '撰写单位或部门' },
              author: { type: 'string', description: '撰写人' },
              date: { type: 'string', description: '日期，如 2026 年 11 月' },
              docNo: { type: 'string', description: '可选文档编号，如 DOC-2026-01' }
            },
            additionalProperties: false
          },
          theme: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '主题名称，如 商务蓝灰、政企深红、科技青蓝、森林墨绿、简约公文' },
              primary: { type: 'string', description: '主色 #RRGGBB（用于标题、章节底线、表头底色）' },
              accent: { type: 'string', description: '强调色 #RRGGBB（用于提示框左边框、封面装饰线、指标顶条）' },
              surface: { type: 'string', description: '浅底色 #RRGGBB（如 #F8FAFC、#F5F7FA）' },
              text: { type: 'string', description: '正文主文字色 #RRGGBB（如 #1F2937）' },
              muted: { type: 'string', description: '辅助文字色 #RRGGBB（如 #64748B）' },
              border: { type: 'string', description: '边框线色 #RRGGBB（如 #CBD5E1）' },
              fontPreset: { type: 'string', enum: ['sans', 'serif', 'fangsong', 'kaiti'], description: '字体风格：sans（微软雅黑，现代商务报告）、serif（宋体正文+黑体标题，合同协议/学术论文）、fangsong（仿宋正文+黑体标题，正式公文/红头文件）、kaiti（楷体，致辞/书信）' },
              fontSize: { type: 'number', minimum: 12, maximum: 18, description: '正文基准字号 px（默认 14.5 约 11pt，适用于绝大多数合同与商务文档；仅当用户明确要求更小或更大时再调整）' },
              lineHeight: { type: 'number', minimum: 1.2, maximum: 2.2, description: '正文行高倍率（默认 1.5；仅当用户要求更紧凑或更宽松时再调整）' },
              paragraphSpacing: { type: 'number', minimum: 2, maximum: 20, description: '段落与列表项间距 px（默认 5；报告长文可酌情用 6-8）' },
              pageMargin: { type: 'string', enum: ['narrow', 'normal', 'wide'], description: 'A4 页边距：narrow（默认，窄边距约 13mm，一页利用率高）、normal（标准 19mm）、wide（宽边距 25mm，适合公文/信函）' },
              headingStyle: { type: 'string', enum: ['underline', 'bar', 'plain', 'center'], description: '一级章节标题样式：underline（底部主色横线）、bar（左侧色条+浅底）、plain（极简纯加粗）、center（居中标题，适合合同/公文/通知）' },
              firstLineIndent: { type: 'boolean', description: '正文段落是否首行缩进 2 字符（公文/学术/长文合同可设 true，默认 false）' },
              tableDensity: { type: 'string', enum: ['compact', 'normal', 'relaxed'], description: '表格单元格紧凑度：compact（默认，紧凑规整）、normal（标准）、relaxed（宽松）' }
            },
            additionalProperties: false
          }
        },
        required: ['title'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upsert_section',
      description: '新增或更新指定序号的 Word 文档章节 HTML。支持单轮并行写入多个章节，或修改现有文档时只更新受影响的章节。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 1, maximum: MAX_WORD_SECTIONS, description: '章节序号（从 1 开始；等于当前总章数+1 表示追加新章）' },
          title: { type: 'string', description: '一级章节标题（自动渲染为 Heading 1 并进入大纲与目录，html 内无需重复写同名 h1）' },
          pageBreakBefore: { type: 'boolean', description: '可选：是否在该章前强制换页，默认 false' },
          html: { type: 'string', description: '该章节正文 HTML 片段（使用 h2/h3/p/ul/ol/table/blockquote/.word-callout/.word-kpi-row/figure+svg 等语义标签，不含外层 html/body/script/style）' }
        },
        required: ['index', 'title', 'html'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remove_section',
      description: '删除一个或多个指定序号的章节，后续章节自动顺延重排。删除多章时请直接传 indices 数组一次完成。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'integer', minimum: 1, maximum: MAX_WORD_SECTIONS, description: '要删除的单个章节序号（从 1 开始）' },
          indices: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: MAX_WORD_SECTIONS },
            description: '批量删除多个章节的序号列表（如 [2, 3, 4, 5, 6]），内部自动从大到小删除'
          }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'inspect_document',
      description: '在真实 A4 宽度浏览器中渲染整份文档，检查水平溢出、元素裁剪、表格列过窄、过小字号并估算打印页数。交付前必须调用并通过全部检查，拿到 docId 后才能结束。',
      parameters: {
        type: 'object',
        properties: {
          sectionIndices: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: MAX_WORD_SECTIONS },
            description: '可选：局部复查指定章节；最终交付前请省略以全量检查并获取 docId'
          }
        },
        additionalProperties: false
      }
    }
  }
];

const wordSystemPrompt = `你是专业 Word 文档设计与撰稿 Agent。你的产出会在右侧 A4 纸张视图中在线预览与原地编辑，并同源导出为原生可编辑 .docx（兼容 Microsoft Word 与 WPS 文字）和矢量 .pdf。

## 交互原则
1. 普通问答、讨论文档提纲或解释现有内容时，直接用简体中文或 {"answer":"..."} 回复，不要修改文档。
2. 当用户要求新建或修改 Word 文档时：
   - 新建文档：先调用 set_doc_meta 确定标题、元信息与配色主题，再调用 upsert_section 逐章撰写（单轮可并行调用最多 4 个 upsert_section 加快速度）。正式文档通常 4-7 章，内容扎实、结构清晰、逻辑严密。
   - 修改现有文档：只调用 upsert_section / remove_section / set_doc_meta 更新受影响的章节，不要无故重写未修改的章节；需要删除多个多余章节时，直接通过一次 remove_section({ indices: [...] }) 批量删除。
   - **必须先自检再交付**：所有修改完成后，必须调用无参数的 inspect_document 在真实 A4 浏览器中检查排版。若返回任何 errors（horizontal_overflow、out_of_bounds、element_overflow、narrow_table_cell、font_too_small），必须修复后重新调用 inspect_document，直到 ok=true 并获得有效 docId。
   - 最终交付只返回一个 JSON 对象：{"summary":"简短中文总结本次撰写或修改要点","docId":"doc-N"}。

## 高质量 Word 文档写作与排版规范（必须遵守）
1. **结构与内容深度**：
   - 避免空话套话，每个章节提供具体论点、结构化要点、可落地的步骤、对比表格或关键指标。
   - 善用多样化文档组件，避免全篇密密麻麻纯文字：
     - **核心摘要 / 重点提示框**：\`<div class="word-callout"><div class="word-callout-title">核心结论</div><p>...</p></div>\`（导出 Word 时自动转为带左侧主色竖线与浅底纹的提示框）。
     - **关键指标条**：\`<div class="word-kpi-row"><div class="word-kpi-card"><div class="word-kpi-value">92%</div><div class="word-kpi-label">目标达成率</div></div>...</div>\`（2-4 项为宜，导出 Word 时自动转为等宽指标卡片表）。
     - **规范数据表格**：\`<table class="word-table"><thead><tr><th>...</th></tr></thead><tbody>...</tbody></table>\`，列数控制在 3-6 列以内，避免单列过窄折行成竖条；内容简明，支持 colspan/rowspan。注意 \`<th>\` 仅用于列标题，合同/表单中的甲乙方信息、填写栏等键值对行应放在 \`<tbody><td>\` 中，不要把填写内容放进深色 \`<thead>\`/\`<th>\`。
     - **合同/表单手写填空实线**：需要留白填写的横线统一使用 \`<span class="word-blank">&nbsp;</span>\`（短空如年/月/日/数字用 \`class="word-blank word-blank-sm"\`，长空如地址/证件号/账号用 \`class="word-blank word-blank-lg"\`），不要用全角 \`＿\` 或带空格下划线 \`_ _\` 拼接（避免渲染成断开的虚线）。
     - **内联矢量图表 / 流程图**：用 \`<figure><svg viewBox="0 0 600 280" width="600" height="280">...</svg><figcaption>图 1 ...</figcaption></figure>\` 清晰绘制趋势图、柱状图、架构图或流程图，导出 Word 时以 2x 高清图像嵌入并附居中图注。
     - **分级标题与列表**：每章自带一级标题（来自 title 参数），html 内从 \`<h2>\`、\`<h3>\` 开始；要点使用标准 \`<ul>\`/\`<ol>\`（支持嵌套子列表），段落重点词用 \`<strong>\` 加粗。
2. **按文档类型主动掌控全局与局部样式（在线预览、PDF、.docx 三端一致）**：
   - **默认基准尺寸（用户未指定字号/行距时直接沿用）**：\`fontSize: 14.5\`（约 11pt）、\`lineHeight: 1.5\`、\`paragraphSpacing: 5\`、\`pageMargin: "narrow"\`（约 13mm）、\`tableDensity: "compact"\`。请不要擅自把默认字号压小到 13px 或把行距拉大。
   - 根据场景搭配字体与结构：
     - **单页简易合同 / 协议 / 申请表**：\`showCover: false, showToc: false, showHeaderFooter: false\`，保留默认基准尺寸（\`fontSize: 14.5, lineHeight: 1.5, paragraphSpacing: 5, pageMargin: "narrow", tableDensity: "compact"\`），搭配 \`fontPreset: "serif"\`、\`headingStyle: "center"\`，配色克制沉稳（如主色 \`#111827\` 炭黑）。
     - **正式公文 / 通知 / 制度**：\`fontPreset: "fangsong"\`、\`firstLineIndent: true\`、\`headingStyle: "center"\` 或 \`"plain"\`，可酌情用 \`fontSize: 15.5, lineHeight: 1.65\`。
     - **商务方案 / 调研报告 / 产品文档**：\`fontPreset: "sans"\`、\`headingStyle: "underline"\` 或 \`"bar"\`，沿用 \`fontSize: 14.5, lineHeight: 1.5\`，可按需开启封面和目录。
   - **局部微调同样生效于导出 .docx**：单个段落或标题上的内联 \`style\`（如 \`text-align: center/right\`、\`margin-top\`、\`margin-bottom\`、\`line-height\`、\`text-indent: 2em\`、\`font-size\`、\`color\`、\`background-color\`）都会被准确同步到导出的 Word 文档中。
3. **A4 排版与导出友好约束**：
   - 正文区域可用宽度随 \`pageMargin\` 变化（\`narrow\` 约 698px，\`normal\` 约 650px，\`wide\` 约 606px）。所有表格、SVG 图宽不得超过正文可用宽度。
   - 严禁使用外链 \`<img>\`、\`<script>\`、\`<style>\`、emoji、\`position: fixed\` 或复杂浮动布局。`;

export async function runWordTurn({
  prompt,
  previousDoc,
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

  const editableTheme = (theme) => {
    if (!theme || typeof theme !== 'object') return undefined;
    const { fontFamily: _f, headingFontFamily: _hf, ...rest } = theme;
    return rest;
  };

  const draft = previousDoc
    ? {
        templateId: previousDoc.templateId || 'default',
        title: previousDoc.title,
        subtitle: previousDoc.subtitle || '',
        headerText: previousDoc.headerText || previousDoc.title,
        showCover: previousDoc.showCover !== false,
        showToc: previousDoc.showToc !== false,
        showHeaderFooter: previousDoc.showHeaderFooter !== false,
        meta: normalizeWordMeta(previousDoc.meta),
        theme: normalizeWordTheme(previousDoc.theme),
        sections: previousDoc.sections.map((section, idx) => ({ ...section, index: idx + 1 }))
      }
    : {
        templateId: 'default',
        title: '未命名文档',
        subtitle: '',
        headerText: '',
        showCover: true,
        showToc: true,
        showHeaderFooter: true,
        meta: normalizeWordMeta(),
        theme: { ...DEFAULT_WORD_THEME },
        sections: []
      };

  let mutated = false;
  let toolOps = 0;
  let verifiedCounter = 0;
  let verifiedSnapshot = null;

  const web = search ? createWebResearchTools({ search, read, signal, onActivity: activity }) : null;
  const attachmentCtx = createAttachmentContext(attachments, { allowTools: true, onActivity: activity });
  const definitions = [
    ...wordTools,
    ...(web ? web.definitions : []),
    ...(attachmentCtx?.toolDefinition ? [attachmentCtx.toolDefinition] : [])
  ];
  const handlers = new Map(web ? web.handlers : []);
  if (attachmentCtx?.toolDefinition) {
    handlers.set(attachmentCtx.toolDefinition.function.name, (args) => attachmentCtx.handler(args));
  }

  handlers.set('set_doc_meta', async ({ title, subtitle, headerText, showCover, showToc, showHeaderFooter, meta, theme }) => {
    let nextMeta = draft.meta;
    let nextTheme = draft.theme;
    try {
      if (meta && typeof meta === 'object') nextMeta = normalizeWordMeta({ ...draft.meta, ...meta });
      if (theme && typeof theme === 'object') nextTheme = normalizeWordTheme({ ...draft.theme, ...theme });
    } catch (error) {
      if (error instanceof PublicError) return JSON.stringify({ ok: false, error: error.message });
      throw error;
    }
    if (typeof title === 'string' && title.trim()) {
      draft.title = title.trim().slice(0, 120);
    }
    if (typeof subtitle === 'string') draft.subtitle = subtitle.trim().slice(0, 200);
    if (typeof headerText === 'string' && headerText.trim()) draft.headerText = headerText.trim().slice(0, 80);
    if (typeof showCover === 'boolean') draft.showCover = showCover;
    if (typeof showToc === 'boolean') draft.showToc = showToc;
    if (typeof showHeaderFooter === 'boolean') draft.showHeaderFooter = showHeaderFooter;
    draft.meta = nextMeta;
    draft.theme = nextTheme;
    mutated = true;
    toolOps++;
    verifiedSnapshot = null;
    activity(`已设定文档信息与主题：${draft.title}`);
    return JSON.stringify({
      ok: true,
      title: draft.title,
      subtitle: draft.subtitle,
      showCover: draft.showCover,
      showToc: draft.showToc,
      showHeaderFooter: draft.showHeaderFooter,
      meta: draft.meta,
      theme: editableTheme(draft.theme)
    });
  });

  handlers.set('upsert_section', async ({ index, title, html, pageBreakBefore }) => {
    if (!Number.isSafeInteger(index) || index < 1 || index > MAX_WORD_SECTIONS) {
      return JSON.stringify({ ok: false, error: `章节序号必须在 1 到 ${MAX_WORD_SECTIONS} 之间。` });
    }
    if (index > draft.sections.length + 1) {
      return JSON.stringify({
        ok: false,
        error: `当前仅有 ${draft.sections.length} 章，请先按顺序创建第 ${draft.sections.length + 1} 章。`
      });
    }
    let section;
    try {
      section = normalizeWordSection({ title, html, pageBreakBefore }, index);
    } catch (error) {
      return JSON.stringify({ ok: false, error: error.message });
    }
    if (index === draft.sections.length + 1) {
      draft.sections.push(section);
    } else {
      draft.sections[index - 1] = section;
    }
    mutated = true;
    toolOps++;
    verifiedSnapshot = null;
    activity(`已撰写第 ${index} 章：${section.title}`);
    return JSON.stringify({ ok: true, index, totalSections: draft.sections.length, title: section.title });
  });

  handlers.set('remove_section', async ({ index, indices } = {}) => {
    const rawList = Array.isArray(indices) && indices.length
      ? indices
      : (index !== undefined ? [index] : []);
    if (!rawList.length) {
      return JSON.stringify({ ok: false, error: '请提供要删除的章节序号 index 或 indices 数组。' });
    }
    const unique = [...new Set(rawList)];
    for (const idx of unique) {
      if (!Number.isSafeInteger(idx) || idx < 1 || idx > draft.sections.length) {
        return JSON.stringify({ ok: false, error: `找不到第 ${idx} 章，当前共 ${draft.sections.length} 章。` });
      }
    }
    // 从大到小删除，避免前序索引位移影响后续删除
    unique.sort((a, b) => b - a);
    const removedTitles = [];
    for (const idx of unique) {
      const [removed] = draft.sections.splice(idx - 1, 1);
      removedTitles.push(`第 ${idx} 章「${removed.title}」`);
    }
    draft.sections.forEach((section, idx) => { section.index = idx + 1; });
    mutated = true;
    toolOps++;
    verifiedSnapshot = null;
    removedTitles.reverse();
    activity(unique.length === 1
      ? `已删除${removedTitles[0]}`
      : `已批量删除 ${unique.length} 个章节（剩余 ${draft.sections.length} 章）`);
    return JSON.stringify({ ok: true, removed: removedTitles, totalSections: draft.sections.length });
  });

  handlers.set('inspect_document', async ({ sectionIndices } = {}) => {
    if (!draft.sections.length) {
      return JSON.stringify({ ok: false, error: '当前还没有任何章节，请先调用 upsert_section 创建章节。' });
    }
    const isFullCheck = !Array.isArray(sectionIndices) || sectionIndices.length === 0;
    const normalized = normalizeWordDoc(draft);
    activity(isFullCheck
      ? `正在用浏览器检查全部 ${normalized.sections.length} 章 A4 排版…`
      : `正在用浏览器复查第 ${sectionIndices.join('、')} 章排版…`);
    toolOps++;
    const report = await inspectWordInBrowser(normalized, isFullCheck ? undefined : sectionIndices, signal);
    if (report.ok && isFullCheck) {
      const id = 'doc-' + (++verifiedCounter);
      verifiedSnapshot = { id, digest: docDigest(normalized), doc: normalized };
      activity(`全部 ${normalized.sections.length} 章排版检查通过（预计 ${report.estimatedPages} 页）`);
      return JSON.stringify({
        ok: true,
        docId: id,
        sectionCount: normalized.sections.length,
        estimatedPages: report.estimatedPages,
        sections: report.sections,
        warnings: report.warnings
      });
    }
    if (!report.ok) {
      activity(`浏览器检查发现 ${report.errors.length} 处排版问题，正在调整…`);
    }
    return JSON.stringify({
      ok: report.ok,
      ...(isFullCheck ? {} : { note: '当前为局部复查，交付前请不传 sectionIndices 做一次全量 inspect_document 以获取 docId。' }),
      sectionCount: normalized.sections.length,
      estimatedPages: report.estimatedPages,
      sections: report.sections,
      errors: report.errors,
      warnings: report.warnings
    });
  });

  const userPayload = previousDoc || recent.length || attachmentCtx
    ? JSON.stringify({
        request: prompt,
        recentDialogue: recent,
        ...(attachmentCtx ? { uploadedAttachments: attachmentCtx.promptText } : {}),
        currentDoc: previousDoc
          ? {
              title: previousDoc.title,
              subtitle: previousDoc.subtitle,
              headerText: previousDoc.headerText,
              showCover: previousDoc.showCover,
              showToc: previousDoc.showToc,
              showHeaderFooter: previousDoc.showHeaderFooter !== false,
              meta: previousDoc.meta,
              theme: editableTheme(previousDoc.theme),
              sections: previousDoc.sections.map(s => ({
                index: s.index,
                title: s.title,
                pageBreakBefore: s.pageBreakBefore,
                html: s.html
              }))
            }
          : null
      })
    : prompt;

  const messages = [
    { role: 'system', content: wordSystemPrompt + (attachmentCtx ? '\n\n' + attachmentCtx.instructions : '') },
    { role: 'user', content: userPayload }
  ];

  const finishInstructions = '请结束工具调用并直接输出最终 JSON。若已通过全量 inspect_document 检查并获得 docId，请返回 {"summary":"简短中文总结","docId":"对应的docId"}；若只是回答问题，直接返回 {"answer":"中文回复"}。';

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
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { /* 按格式要求提示模型纠正 */ }
      }

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (typeof parsed.docId === 'string' && parsed.docId.trim()) {
          if (!draft.sections.length) throw new PublicError(422, '当前没有任何文档章节可交付。');
          const current = normalizeWordDoc(draft);
          const currentHash = docDigest(current);
          if (!verifiedSnapshot || parsed.docId.trim() !== verifiedSnapshot.id || verifiedSnapshot.digest !== currentHash) {
            throw new PublicError(422, '文档在最近一次全量检查后有改动或尚未通过检查，请先调用无参数的 inspect_document 并通过后再提交对应 docId。');
          }
          const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
            ? parsed.summary.trim().slice(0, 4000)
            : `已完成「${current.title}」，共 ${current.sections.length} 章并已通过浏览器排版检查。`;
          return { type: 'word', doc: verifiedSnapshot.doc, summary };
        }
        if (typeof parsed.answer === 'string' && parsed.answer.trim()) {
          if (mutated) {
            throw new PublicError(422, '本轮已创建或修改了 Word 文档，请先调用无参数的 inspect_document 通过排版检查，再返回 {"summary":"...","docId":"..."}。');
          }
          return { type: 'answer', text: parsed.answer.trim().slice(0, 8000) };
        }
      }

      if (mutated) {
        if (verifiedSnapshot) {
          const current = normalizeWordDoc(draft);
          if (docDigest(current) === verifiedSnapshot.digest) {
            const summary = cleaned ? cleaned.slice(0, 4000) : `已完成「${current.title}」，共 ${current.sections.length} 章。`;
            return { type: 'word', doc: verifiedSnapshot.doc, summary };
          }
        }
        throw new PublicError(422, '本轮已修改了 Word 文档但尚未完成全量 inspect_document 检查，请先调用无参数的 inspect_document，通过后再返回 {"summary":"...","docId":"..."}。');
      }
      if (!cleaned) throw new PublicError(422, '对话回复为空，请重试。');
      return { type: 'answer', text: cleaned.slice(0, 8000) };
    },
    correction(error) {
      return {
        kind: 'word',
        message: error.message,
        allowTools: true
      };
    },
    recoverVerifiedDraft() {
      if (!verifiedSnapshot) return undefined;
      return {
        type: 'word',
        doc: verifiedSnapshot.doc,
        summary: `已完成「${verifiedSnapshot.doc.title}」，共 ${verifiedSnapshot.doc.sections.length} 章（已通过浏览器排版检查）。`
      };
    }
  });
}
