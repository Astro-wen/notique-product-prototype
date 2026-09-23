import { clockTimestamp } from './transcript-export.ts';

export type ExportDocument = { title: string; paragraphs: string[] };
const encoder = new TextEncoder();
const crcTable = Array.from({length: 256}, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Standard uncompressed ZIP: also used as the Open XML container for DOCX. */
export function zipFiles(files: {name: string; data: Uint8Array}[]): Uint8Array<ArrayBuffer> {
  if (files.length > 0xffff) throw new Error("导出文件数量超过 ZIP 格式限制，请分批导出。");
  const parts: Uint8Array[] = [], directory: Uint8Array[] = [];
  let offset = 0, directorySize = 0;
  for (const file of files) {
    const name = encoder.encode(file.name), crc = crc32(file.data);
    if (name.length > 0xffff) throw new Error("文件名太长，改短项目或记录名称");
    if (file.data.length > 0xffffffff || offset > 0xffffffff || directorySize > 0xffffffff) {
      throw new Error("导出内容过大，请分批导出。");
    }
    const local = new Uint8Array(30 + name.length), l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true);
    l.setUint32(14, crc, true); l.setUint32(18, file.data.length, true); l.setUint32(22, file.data.length, true);
    l.setUint16(26, name.length, true); local.set(name, 30);
    const central = new Uint8Array(46 + name.length), c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true);
    c.setUint32(16, crc, true); c.setUint32(20, file.data.length, true); c.setUint32(24, file.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true); central.set(name, 46);
    if (offset + local.length + file.data.length > 0xffffffff) throw new Error("导出内容过大，请分批导出。");
    parts.push(local, file.data); directory.push(central); offset += local.length + file.data.length; directorySize += central.length;
    if (directorySize > 0xffffffff) throw new Error("导出内容过大，请分批导出。");
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true); e.setUint32(16, offset, true);
  const result = new Uint8Array(offset + directorySize + end.length);
  let cursor = 0;
  for (const part of [...parts, ...directory, end]) { result.set(part, cursor); cursor += part.length; }
  return result;
}
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function documentBytes(document: ExportDocument, format: 'txt' | 'docx'): Uint8Array<ArrayBuffer> {
  const paragraphs = [document.title, ...document.paragraphs];
  if (format === 'txt') return encoder.encode(paragraphs.join('\n\n') + '\n');
  return zipFiles([
    {name:'[Content_Types].xml', data:encoder.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')},
    {name:'_rels/.rels', data:encoder.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')},
    {name:'word/document.xml', data:encoder.encode('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+paragraphs.map((p,i)=>`<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r>${i===0?'<w:rPr><w:b/><w:sz w:val="32"/></w:rPr>':''}<w:t xml:space="preserve">${xml(p)}</w:t></w:r></w:p>`).join('')+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>')},
  ]);
}
export function transcriptParagraphs(segments: {speaker: string | null; start_ms: number | null; text: string}[], speakers: boolean, timestamps: boolean): string[] {
  return segments.map(s => [timestamps && s.start_ms !== null ? `[${clockTimestamp(s.start_ms)}]` : '', speakers ? s.speaker || '说话人待确认' : '', s.text].filter(Boolean).join(' '));
}
