import { extname } from 'node:path';
import { Readable } from 'node:stream';
import JSZip from 'jszip';
import { PublicError } from './models.mjs';

// 单个附件最大 10 MB，与前端校验和 Fastify bodyLimit 保持一致
export const attachmentUploadLimit = 10 * 1024 * 1024;
const textLimit = 600000;
const archiveLimit = 32 * 1024 * 1024;

// 纯文本格式在站内直接解码读取
export const textExtensions = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log'
]);

// 文档与图片格式统一提交 MinerU 精准解析 API
export const mineruExtensions = new Set([
  '.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx', '.pdf',
  '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp'
]);

// 图片类使用 vlm 模型（避免 pipeline 版面分析把 UI 截图/卡片误判为插图只输出 ![](images/...)）；文档类用 pipeline 提速
const imageExtensions = new Set([
  '.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp'
]);

export function attachmentFileType(name) {
  const type = extname(name).toLowerCase();
  const supported = textExtensions.has(type) || mineruExtensions.has(type);
  if (!supported || /[/\\\u0000-\u001f\u007f]/u.test(name)) {
    throw new PublicError(400, '请选择 Excel、Word、PPT、PDF、图片或文本文件。');
  }
  return type;
}

function normalizeDocumentText(text) {
  const value = text.replace(/\r\n?/g, '\n').trim();
  if (!value || value.includes('\0')) throw new PublicError(422, '文件中没有可读取的文字内容。');
  if (value.length > textLimit) throw new PublicError(413, '提取的文字过多，请将文件拆分后再上传。');
  return value;
}

function decodeText(bytes) {
  for (const encoding of ['utf-8', 'gb18030']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // 尝试下一个支持的常见文本编码
    }
  }
  throw new PublicError(422, '无法识别文本文件编码，请另存为 UTF-8 后重试。');
}

async function readLimited(stream, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maximum) throw new PublicError(413, '解析结果过大，请拆分原文件。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cleanMineruMarkdown(text) {
  // 去掉 MinerU 压缩包内部相对路径图片占位符（如 ![](images/xxx.jpg)），避免模型误把占位符当有效内容
  const stripped = text.replace(/!\[[^\]]*\]\((?:\.\/)?images\/[^)\s]+\)/gi, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!stripped) {
    throw new PublicError(422, '未能从文件中提取到可读文字（仅检测到纯图形区域）。');
  }
  return normalizeDocumentText(stripped);
}

async function readMarkdownFromZip(body) {
  const zip = await JSZip.loadAsync(await readLimited(body, archiveLimit));
  const entry = zip.file('full.md') ?? zip.file(/(?:^|\/)full\.md$/i)[0];
  if (!entry) throw new PublicError(422, 'MinerU 的解析结果中没有正文内容。');
  const text = await readLimited(Readable.wrap(entry.nodeStream()), textLimit * 4);
  return cleanMineruMarkdown(new TextDecoder().decode(text));
}

function storageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !(
    url.hostname.endsWith('.aliyuncs.com') || url.hostname.endsWith('.openxlab.org.cn') ||
    url.hostname.endsWith('.opendatalab.com') || url.hostname.endsWith('.mineru.net')
  )) {
    throw new PublicError(502, 'MinerU 返回了不可信的存储地址。');
  }
  return url;
}

function mapMineruError(code, msg) {
  const key = String(code ?? '');
  if (key === 'A0202' || key === 'A0211') {
    return new PublicError(503, 'MinerU API Key 无效或已过期，请检查环境变量 MINERU_API_KEY。');
  }
  if (key === '-60002') return new PublicError(400, 'MinerU 不支持该文件格式，请确认扩展名正确。');
  if (key === '-60003' || key === '-60004') return new PublicError(422, '文件为空或已损坏，请检查后重新上传。');
  if (key === '-60005') return new PublicError(413, '文件大小超出 MinerU 限制。');
  if (key === '-60006') return new PublicError(422, '文件页数超出 MinerU 限制，请拆分后上传。');
  if (key === '-60012') return new PublicError(422, 'MinerU 解析任务已失效，请重新上传。');
  if (key === '-60015' || key === '-60016') return new PublicError(422, 'MinerU 转换该文件失败，建议转为 PDF 后重试。');
  if (key === '-60018') return new PublicError(429, 'MinerU 今日解析任务额度已达上限，请明天再试。');
  const detail = typeof msg === 'string' && msg.trim() && msg.trim().toLowerCase() !== 'ok' ? `（${msg.trim().slice(0, 80)}）` : '';
  return new PublicError(502, 'MinerU 暂时无法处理文件，请稍后重试。' + detail);
}

export function makeDocumentParser(key, request = fetch) {
  const fetchTimed = (url, options) =>
    request(url, { redirect: 'error', signal: AbortSignal.timeout(25000), ...options });

  async function mineru(path, body) {
    if (!key) throw new PublicError(503, '平台尚未配置 MINERU_API_KEY，当前只能直接读取文本文件。');
    const response = await fetchTimed('https://mineru.net/api/v4/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      ...(body && { body: JSON.stringify(body) })
    });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value || value.code !== 0 || !value.data) {
      throw mapMineruError(value?.code, value?.msg);
    }
    return value.data;
  }

  return {
    enabled: Boolean(key),
    async submit(name, bytes) {
      const type = attachmentFileType(name);
      if (textExtensions.has(type)) {
        return { text: normalizeDocumentText(decodeText(bytes)) };
      }
      const isImage = imageExtensions.has(type);
      const data = await mineru('file-urls/batch', {
        files: [{ name, is_ocr: isImage }],
        model_version: isImage ? 'vlm' : 'pipeline'
      });
      if (typeof data.batch_id !== 'string' || !/^[\da-z-]{1,100}$/i.test(data.batch_id) || !data.file_urls?.[0]) {
        throw new PublicError(502, 'MinerU 未返回有效的上传任务。');
      }
      // MinerU 文档明确要求上传到 OSS 签名链接时不设置 Content-Type 头
      const upload = await fetchTimed(storageUrl(data.file_urls[0]), { method: 'PUT', body: bytes });
      if (!upload.ok) throw new PublicError(502, '文件未能上传到 MinerU，请重试。');
      return { batch: data.batch_id };
    },
    async check(batch) {
      const data = await mineru('extract-results/batch/' + encodeURIComponent(batch));
      const result = data.extract_result?.[0];
      if (!result) return null;
      if (result.state === 'failed') {
        const reason = typeof result.err_msg === 'string' && result.err_msg.trim()
          ? result.err_msg.trim().slice(0, 120)
          : '请检查文件是否损坏或加密';
        throw new PublicError(422, 'MinerU 解析失败：' + reason);
      }
      if (result.state !== 'done') return null;
      const response = await fetchTimed(storageUrl(result.full_zip_url));
      if (!response.ok) throw new PublicError(502, '暂时无法下载 MinerU 的解析结果。');
      return readMarkdownFromZip(response.body);
    }
  };
}
