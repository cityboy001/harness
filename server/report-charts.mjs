import { DomUtils, parseDocument } from 'htmlparser2';

const derivedClass = 'report-table-chart';
const classes = node => (node.attribs?.class ?? '').split(/\s+/);
const tag = (node, names) => names.includes(node.name);
const plainText = node => DomUtils.textContent(node).replace(/\s+/gu, ' ').trim();
const dimension = /^(?:日期|时间|年度|季度|月份|期间|年份|财年|地区|区域|市场|公司|企业|类别|分类|品牌|产品)$/u;

function periodGroup(name) {
  const compact = name.replace(/\s/gu, '');
  const yearToDate = compact.match(/前([一二三四1-4])季度/u);
  if (yearToDate) return 'ytd-' + yearToDate[1];
  if (/(?:上半年|下半年|[Hh][12])$/u.test(compact)) return 'half';
  if (/(?:第?[一二三四1-4]季度|[Qq][1-4])$/u.test(compact)) return 'quarter';
  const range = compact.match(/(\d{1,2})[-–—至](\d{1,2})月$/u);
  if (range) return 'months-' + range[1] + '-' + range[2];
  if (/^(?:20\d{2}年)?\d{1,2}月$/u.test(compact)) return 'month';
  if (/^20\d{2}年?(?:全年|年度)?$/u.test(compact)) return 'year';
  if (/^(?:本期|上期|上年同期)$/u.test(compact)) return 'relative';
}

function parseReport(html) {
  return parseDocument(html, { withStartIndices: true, withEndIndices: true });
}

function readAmount(text) {
  const match = /^(\d{1,3}(?:[,，]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([^\d()（）\s]{0,12})\s*(?:[（(][^（）()]*[）)])?$/u.exec(text);
  if (!match) return undefined;
  const value = Number(match[1].replace(/[,，]/gu, ''));
  if (!Number.isFinite(value)) return undefined;
  return { value, unit: match[2], label: match[1] + (match[2] ? ' ' + match[2] : '') };
}

function comparison(heading, labels, amounts) {
  const points = labels.flatMap((label, index) => label && amounts[index] ? [{ name: label, ...amounts[index] }] : []).slice(0, 8);
  if (!heading || points.length < 2 || new Set(points.map(point => point.name)).size !== points.length ||
      new Set(points.map(point => point.unit)).size !== 1 || !points.some(point => point.value > 0)) return;
  return { heading, points };
}

function tableComparison(table) {
  const rows = DomUtils.findAll(node => node.name === 'tr', table.children).slice(0, 24);
  const cells = rows.map(row => row.children.filter(cell => tag(cell, ['th', 'td'])));
  if (cells.length < 2 || !cells[0].every(cell => cell.name === 'th') ||
      cells.some(row => row.some(cell => cell.attribs?.colspan || cell.attribs?.rowspan))) return;
  const [headers, ...body] = cells.map(row => row.map(plainText));
  const caption = table.children.find(node => node.name === 'caption');
  const title = caption ? plainText(caption) : '';
  const groups = new Map();
  for (const [index, name] of headers.slice(1).entries()) {
    const group = periodGroup(name);
    if (group) groups.set(group, [...(groups.get(group) ?? []), index + 1]);
  }
  for (const periods of groups.values()) {
    if (periods.length < 2) continue;
    for (const row of body) {
      const result = comparison(row[0], periods.map(index => headers[index]), periods.map(index => readAmount(row[index] ?? '')));
      if (result) return { ...result, title };
    }
  }
  if (dimension.test(headers[0])) {
    for (const [index, name] of headers.entries()) {
      if (!index) continue;
      const result = comparison(name, body.map(row => row[0]), body.map(row => readAmount(row[index] ?? '')));
      if (result) return { ...result, title };
    }
  }
}

const escapeHtml = value => String(value).replace(/[&<>"']/gu, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[ch]);

function renderComparison({ heading, points, title }) {
  const maximum = Math.max(...points.map(point => point.value));
  const bars = points.map(({ name, value, label }) => '<div class="report-bar"><p>' + escapeHtml(name) +
    ' <strong>' + escapeHtml(label) + '</strong></p><meter min="0" max="' + maximum + '" value="' + value +
    '" aria-label="' + escapeHtml(name) + '"></meter></div>').join('');
  return '<figure class="report-chart ' + derivedClass + '" contenteditable="false"><figcaption>' + escapeHtml(heading) + '</figcaption>' + bars +
    (title ? '<p class="report-chart-note">数据来自正文表格《' + escapeHtml(title) + '》。</p>' :
      '<p class="report-chart-note">数据来自正文表格。</p>') + '</figure>';
}

export function removeTableCharts(html) {
  const charts = DomUtils.findAll(node => node.name === 'figure' && classes(node).includes(derivedClass), parseReport(html).children);
  return charts.reduceRight((result, chart) => result.slice(0, chart.startIndex) + result.slice(chart.endIndex + 1), html);
}

export function showReportCharts(html) {
  const nodes = parseReport(html).children;
  const chart = DomUtils.findAll(node => node.name === 'figure' && classes(node).includes('report-chart') &&
    DomUtils.findOne(child => child.name === 'meter', node.children), nodes)[0];
  const firstSection = nodes.find(node => node.name === 'h2');
  const top = nodes.find(node => classes(node).includes('report-metrics')) ??
    nodes.find(node => classes(node).includes('report-cover') || node.name === 'h1');
  const insertion = top ? top.endIndex + 1 : firstSection?.endIndex + 1 || 0;
  if (chart) {
    if (!nodes.includes(chart) || chart.startIndex <= insertion || /^(?:\s|&(nbsp|#160);)*$/u.test(html.slice(insertion, chart.startIndex))) return html;
    return html.slice(0, insertion) + html.slice(chart.startIndex, chart.endIndex + 1) +
      html.slice(insertion, chart.startIndex) + html.slice(chart.endIndex + 1);
  }
  const series = DomUtils.findAll(node => node.name === 'table', nodes).map(tableComparison).find(Boolean);
  if (!series) return html;
  const illustration = renderComparison(series);
  if (Buffer.byteLength(html) + Buffer.byteLength(illustration) > 120000) return html;
  return html.slice(0, insertion) + illustration + html.slice(insertion);
}
