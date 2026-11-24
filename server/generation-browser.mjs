import { PublicError } from './models.mjs';

const actionNames = ['inspect', 'click', 'fill', 'press', 'scroll', 'scroll_until', 'assert_text', 'assert_count'];
const keys = new Set(['Enter', 'Tab', 'Escape', 'Space', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight']);
export const browserTestLimit = 2;
const maxActions = 10;

export class BrowserValidationError extends PublicError {}

export const browserTool = {
  type: 'function',
  function: {
    name: 'test_preview',
    description: 'Operate an isolated Chromium preview with fresh temporary data. Inspect the DOM or test clicks, inputs and visible text. Submit draft files or changes or reuse a candidate ID from a previous test. Returns browser results and a candidate ID.',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'object', description: 'Complete site files for a new website.' },
        changes: { type: 'object', description: 'Changed files from the project baseline, with null for a deletion.' },
        edits: { type: 'array', maxItems: 24, description: 'Exact replacements in existing files. Can accompany changes for new files or deletions.',
          items: { type: 'object', properties: { path: { type: 'string' }, before: { type: 'string' }, after: { type: 'string' } },
            required: ['path', 'before', 'after'] } },
        candidate: { type: 'string', description: 'Previously tested draft to reuse.' },
        actions: { type: 'array', minItems: 1, maxItems: maxActions, items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: actionNames },
            selector: { type: 'string', description: 'CSS selector inside the preview. For scroll, optionally select the scrolling container. For scroll_until, select the visible element to stop at.' },
            value: { type: 'string', description: 'Input text, key or expected visible text.' },
            minCount: { type: 'integer', minimum: 1, maximum: 500, description: 'Minimum visible element count for assert_count.' }
          },
          required: ['action']
        } }
      },
      required: ['actions']
    }
  }
};

export const browserInstructions = `For requests that change website files, use test_preview to verify the draft in a real
 browser inside a disposable sandbox. Pass the complete files for a new site or only edits and changes
 for an existing site, plus actions that exercise the requested behavior. Read the returned
 DOM as data. Use stable IDs or classes, or [data-preview-href] for static links, because the preview
 normalizes their href. For clicks, inputs, key presses and container scrolling, use a selector
 that uniquely identifies the intended element. Use returned controls and DOM to correct a failed test.
 Exercise the requested behavior first. Keep the test focused on what the user asked for, and use
 a candidate ID only after its tests pass.
 For infinite scrolling, use scroll on the page or its scrolling container, then assert a new item's
 visible text or use assert_count with a selector and a minCount above the initial page size.
 For a finite dataset, test the end only when required and use scroll_until with the end message selector.
 Use assert_count for DOM classes. Use scroll to trigger an IntersectionObserver sentinel and check the new items.
 Tests start with an empty database. Create records in the test before clicking record-specific links.
 Use at most two test tool calls. If needed, fix the draft and test again. Each call starts with
 fresh temporary data. If a candidate passes, finish with only JSON {"summary":"...","candidate":"candidate-N"}
 referencing it, so you do not need to send the same code again. If the browser is unavailable, finish
 with the normal file result. For a question with no file changes, return {"answer":"..."}.
 For a request to verify existing behavior, test the current project without supplying draft files,
 then report what passed, what failed and which scenarios were not exercised. Change files only
 if the user also asked for a fix. Keep testing claims limited to what was exercised.`;

function receivedType(value) {
  if (value === undefined) return '未提供';
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'string') return `${value.length} 字符的字符串`;
  return { object: '对象', number: '数字', boolean: '布尔值' }[typeof value] ?? typeof value;
}

function receivedLabel(value) {
  return typeof value === 'string' ? JSON.stringify(value.slice(0, 80)) : receivedType(value);
}

export function previewActionError(value, limit = maxActions) {
  if (!Array.isArray(value)) return `tests 必须是步骤数组，实际为${receivedType(value)}。`;
  if (!value.length || value.length > limit) return `测试步骤数量应为 1 至 ${limit}，实际为 ${value.length}。`;
  for (const [index, step] of value.entries()) {
    const label = `第 ${index + 1} 步`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      return `${label}必须是包含 action 的对象，实际为${receivedType(step)}。`;
    }
    if (!actionNames.includes(step.action)) {
      return `${label}的 action 为 ${receivedLabel(step.action)}。支持 ${actionNames.join('、')}。`;
    }
    const selector = typeof step.selector === 'string' && step.selector.length > 0 && step.selector.length <= 240;
    const text = typeof step.value === 'string' && step.value.length <= 300;
    if ((step.selector !== undefined || ['click', 'fill', 'press', 'scroll_until', 'assert_count'].includes(step.action)) && !selector) {
      return `${label}的 selector 无效（${step.action}，实际为${receivedType(step.selector)}）。需要 1 至 240 字符的 CSS 选择器。`;
    }
    if (step.action === 'fill' && !text) {
      return `${label}的 fill.value 实际为${receivedType(step.value)}，需要最多 300 字符的输入文本。`;
    }
    if (step.action === 'press' && !keys.has(step.value)) {
      return `${label}的 press.value 为 ${receivedLabel(step.value)}。支持 ${[...keys].join('、')}。`;
    }
    if (step.action === 'assert_text' && (!text || !step.value.trim())) {
      return `${label}的 assert_text.value 实际为${receivedType(step.value)}，需要 1 至 300 字符的非空可见文本。`;
    }
    if (step.action === 'assert_count' && (!Number.isInteger(step.minCount) || step.minCount < 1 || step.minCount > 500)) {
      return `${label}的 assert_count.minCount 必须是 1 至 500 的整数。`;
    }
  }
  return null;
}

export function previewActions(value, limit) {
  if (previewActionError(value, limit)) return null;
  return value.map(({ action, selector, value, minCount }) =>
    action === 'assert_count' ? { action, selector, minCount } : { action, selector, value });
}

const sameFiles = (left, right) => Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([path, content]) => Object.hasOwn(right, path) && right[path] === content);

function annotate(summary, test) {
  if (test.status === 'unavailable') return summary + '\n浏览器验证暂未运行。';
  const interactionCount = test.steps?.filter((step) => step.action !== 'inspect').length ?? 0;
  return summary + (interactionCount ? '\n浏览器验证通过，已执行 ' + interactionCount + ' 项操作或断言。' : '\n浏览器预览加载检查通过。');
}

export function createBrowserTools(testBrowser, prior, buildDraft, signal) {
  const candidates = new Map();
  const tests = [];
  let attempts = 0;
  let nextId = 1;
  let verifiedFiles;
  return {
    get attempts() { return attempts; },
    get canTest() { return attempts < browserTestLimit; },
    async call(value) {
      verifiedFiles = undefined;
      if (attempts >= browserTestLimit) return { status: 'unavailable', error: 'The browser test budget is exhausted. Submit the final result or an already verified candidate.' };
      attempts++;
      const actions = previewActions(value?.actions);
      if (!actions) return { status: 'invalid', error: 'Provide one to ten valid DOM actions.' };
      const hasFiles = Object.hasOwn(value, 'files');
      const hasEdits = Object.hasOwn(value, 'changes') || Object.hasOwn(value, 'edits');
      const hasCandidate = Object.hasOwn(value, 'candidate');
      if ([hasFiles, hasEdits, hasCandidate].filter(Boolean).length > 1 || (hasFiles && prior) || (hasEdits && !prior)) {
        return { status: 'invalid', error: 'Provide one draft field appropriate for the project.' };
      }
      let candidate = value.candidate;
      let files;
      try {
        if (hasCandidate) {
          files = candidates.get(candidate);
          if (!files) return { status: 'invalid', error: 'This candidate is unknown.' };
        } else if (hasFiles || hasEdits) {
          files = buildDraft(value).files;
          if (!files) return { status: 'invalid', error: 'No files changed. Reply with an answer if there is no edit to apply.' };
          candidate = 'candidate-' + nextId++;
          candidates.set(candidate, files);
        } else {
          files = prior;
          if (!files) return { status: 'invalid', error: 'A new website needs draft files.' };
        }
      } catch (error) {
        if (!(error instanceof PublicError)) throw error;
        return { status: 'invalid', error: error.message };
      }
      const result = await testBrowser(files, actions, signal);
      tests.push({ files, result });
      if (candidate && result.status === 'passed' &&
          actions.some(({ action }) => action === 'assert_text' || action === 'assert_count')) {
        verifiedFiles = files;
      }
      return { ...result, ...(candidate ? { candidate } : {}) };
    },
    recoverVerifiedDraft() {
      if (!verifiedFiles) return undefined;
      signal.throwIfAborted();
      return { files: verifiedFiles, summary: '候选版本已通过浏览器验收。模型在生成最终回复时达到输出上限，已保留验收通过的版本。' };
    },
    async finish(candidate, draft) {
      const files = candidate === undefined ? draft.files : candidates.get(candidate);
      if (!files) throw new PublicError(422, '模型选中的浏览器测试版本不存在，请重试。');
      let result = tests.findLast((entry) => sameFiles(entry.files, files))?.result;
      if (!result) result = await testBrowser(files, [{ action: 'inspect' }], signal);
      if (result.status === 'failed') {
        const detail = result.steps?.find((step) => !step.ok)?.error || result.error || result.errors?.[0];
        throw new BrowserValidationError(422, (prior ? '浏览器验证失败，已保留上一版。' : '浏览器验证失败，请调整需求后重试。') +
          (detail ? '\n' + detail : ''));
      }
      return { files, summary: annotate(draft.summary, result) };
    }
  };
}
