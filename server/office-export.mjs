import PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, HeadingLevel } from 'docx';

function cleanText(value) {
  return typeof value === 'string' ? value : '';
}

export async function exportOfficeDocument(document) {
  const kind = document?.type;
  if (kind === 'ppt') {
    const pptx = new PptxGenJS();
    pptx.author = '建站工作台';
    pptx.title = cleanText(document.title);
    pptx.subject = '由结构化 JSON 导出';
    pptx.layout = 'LAYOUT_WIDE';
    for (const slideData of document.slides ?? []) {
      const slide = pptx.addSlide();
      slide.background = { color: 'F7F8FC' };
      slide.addText(cleanText(slideData.title), {
        x: 0.7, y: 0.55, w: 11.9, h: 0.75,
        fontFace: 'Microsoft YaHei', fontSize: 28, bold: true, color: '222338'
      });
      if (slideData.subtitle) {
        slide.addText(cleanText(slideData.subtitle), {
          x: 0.72, y: 1.25, w: 11.7, h: 0.55,
          fontFace: 'Microsoft YaHei', fontSize: 15, color: '62647A'
        });
      }
      const bullets = Array.isArray(slideData.bullets) ? slideData.bullets : [];
      bullets.forEach((text, index) => {
        slide.addText(cleanText(text), {
          x: 1.1, y: 2.0 + index * 0.72, w: 10.9, h: 0.55,
          fontFace: 'Microsoft YaHei', fontSize: 18, color: '33364A',
          bullet: { indent: 18 }, breakLine: false
        });
      });
    }
    const data = await pptx.write({ outputType: 'nodebuffer' });
    return { buffer: Buffer.from(data), extension: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
  }
  if (kind === 'excel') {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = '建站工作台';
    for (const sheetData of document.sheets ?? []) {
      const sheet = workbook.addWorksheet(cleanText(sheetData.name).slice(0, 31) || 'Sheet1');
      const headers = Array.isArray(sheetData.headers) ? sheetData.headers : [];
      if (headers.length) {
        sheet.addRow(headers);
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5242A8' } };
      }
      for (const row of sheetData.rows ?? []) sheet.addRow(Array.isArray(row) ? row : []);
      sheet.columns.forEach((column) => { column.width = 18; });
      sheet.getRows(1, sheet.rowCount)?.forEach((row) => { row.height = 22; });
    }
    if (!workbook.worksheets.length) workbook.addWorksheet('Sheet1');
    const data = await workbook.xlsx.writeBuffer();
    return { buffer: Buffer.from(data), extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  if (kind === 'word') {
    const children = [
      new Paragraph({
        text: cleanText(document.title) || '文档',
        heading: HeadingLevel.TITLE,
        spacing: { after: 300 }
      })
    ];
    for (const section of document.sections ?? []) {
      if (section.title) children.push(new Paragraph({ text: cleanText(section.title), heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
      for (const paragraph of section.paragraphs ?? []) {
        children.push(new Paragraph({ children: [new TextRun(cleanText(paragraph))], spacing: { after: 120 } }));
      }
      if (Array.isArray(section.table?.headers) && Array.isArray(section.table?.rows)) {
        const rows = [section.table.headers, ...section.table.rows];
        children.push(new Table({
          rows: rows.map((row, rowIndex) => new TableRow({
            children: row.map((value) => new TableCell({
              children: [new Paragraph(cleanText(value))]
            }))
          }))
        }));
      }
    }
    const file = new Document({
      creator: '建站工作台',
      title: cleanText(document.title),
      sections: [{ properties: {}, children }]
    });
    const data = await Packer.toBuffer(file);
    return { buffer: data, extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  throw new Error('不支持的文档类型');
}
