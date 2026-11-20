// Zero-dependency OpenXML Spreadsheet (XLSX) writer and store-only ZIP generator.
import { decodeEntities, downloadBlob, extractTableCellText, fromCsv, rowCells, tableRows, tableToRows } from './csv.js';
import { parseAmount } from './models/common.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 checksum of a byte buffer. */
export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Store-only (compression method 0) ZIP writer.
 * Takes a record of `{ [path]: string | Uint8Array }` and returns a Uint8Array.
 */
export function createZip(files) {
  const encoder = new TextEncoder();
  const fileEntries = Object.entries(files).map(([name, content]) => {
    const data = typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
    const nameBytes = encoder.encode(name);
    return { name, nameBytes, data, crc: crc32(data), size: data.length };
  });

  const localHeaders = [];
  let offset = 0;
  for (const entry of fileEntries) {
    entry.offset = offset;
    const header = new Uint8Array(30 + entry.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 20, true);         // Version needed to extract (2.0)
    view.setUint16(6, 0x0800, true);     // Flags: UTF-8 filename (bit 11)
    view.setUint16(8, 0, true);          // Compression method: 0 (stored)
    view.setUint16(10, 0, true);         // Mod time
    view.setUint16(12, 0x4821, true);    // Mod date: 2016-01-01
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.size, true);// Compressed size
    view.setUint32(22, entry.size, true);// Uncompressed size
    view.setUint16(26, entry.nameBytes.length, true);
    view.setUint16(28, 0, true);         // Extra field length
    header.set(entry.nameBytes, 30);
    localHeaders.push(header, entry.data);
    offset += header.length + entry.data.length;
  }

  const centralOffset = offset;
  const centralHeaders = [];
  for (const entry of fileEntries) {
    const header = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true); // Central directory header signature
    view.setUint16(4, 20, true);         // Version made by
    view.setUint16(6, 20, true);         // Version needed
    view.setUint16(8, 0x0800, true);     // Flags: UTF-8
    view.setUint16(10, 0, true);         // Compression method: 0
    view.setUint16(12, 0, true);         // Mod time
    view.setUint16(14, 0x4821, true);    // Mod date
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);// Compressed size
    view.setUint32(24, entry.size, true);// Uncompressed size
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint16(30, 0, true);         // Extra length
    view.setUint16(32, 0, true);         // Comment length
    view.setUint16(34, 0, true);         // Disk start
    view.setUint16(36, 0, true);         // Internal attributes
    view.setUint32(38, 0, true);         // External attributes
    view.setUint32(42, entry.offset, true); // Local header offset
    header.set(entry.nameBytes, 46);
    centralHeaders.push(header);
    offset += header.length;
  }
  const centralSize = offset - centralOffset;

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // End of central dir signature
  eocdView.setUint16(4, 0, true);          // Disk number
  eocdView.setUint16(6, 0, true);          // Disk with central dir
  eocdView.setUint16(8, fileEntries.length, true);  // Entries on disk
  eocdView.setUint16(10, fileEntries.length, true); // Total entries
  eocdView.setUint32(12, centralSize, true);        // Central dir size
  eocdView.setUint32(16, centralOffset, true);      // Central dir offset
  eocdView.setUint16(20, 0, true);                  // Comment length

  const allParts = [...localHeaders, ...centralHeaders, eocd];
  const totalLen = allParts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of allParts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** Parse files, central directory, and EOCD of a store-only ZIP buffer (for testing and verification). */
export function parseZip(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files = {};
  let pos = 0;
  while (pos <= bytes.length - 4) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x04034b50) break;
    const offset = pos;
    const compression = view.getUint16(pos + 8, true);
    const crc = view.getUint32(pos + 14, true);
    const cSize = view.getUint32(pos + 18, true);
    const uSize = view.getUint32(pos + 22, true);
    const fnLen = view.getUint16(pos + 26, true);
    const extraLen = view.getUint16(pos + 28, true);
    const filename = decoder.decode(bytes.subarray(pos + 30, pos + 30 + fnLen));
    const dataOffset = pos + 30 + fnLen + extraLen;
    const data = bytes.subarray(dataOffset, dataOffset + uSize);
    files[filename] = { filename, compression, crc, compressedSize: cSize, size: uSize, data, offset };
    pos = dataOffset + cSize;
  }

  const centralOffset = pos;
  const centralDirectory = [];
  while (pos <= bytes.length - 46) {
    const sig = view.getUint32(pos, true);
    if (sig !== 0x02014b50) break;
    const compression = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const cSize = view.getUint32(pos + 20, true);
    const uSize = view.getUint32(pos + 24, true);
    const fnLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const filename = decoder.decode(bytes.subarray(pos + 46, pos + 46 + fnLen));
    centralDirectory.push({ filename, compression, crc, compressedSize: cSize, size: uSize, localHeaderOffset });
    pos += 46 + fnLen + extraLen + commentLen;
  }

  let eocd = null;
  if (pos <= bytes.length - 22 && view.getUint32(pos, true) === 0x06054b50) {
    eocd = {
      signature: view.getUint32(pos, true),
      entriesOnDisk: view.getUint16(pos + 8, true),
      totalEntries: view.getUint16(pos + 10, true),
      centralSize: view.getUint32(pos + 12, true),
      centralOffset: view.getUint32(pos + 16, true),
      actualCentralOffset: centralOffset,
    };
  }
  return { files, centralDirectory, eocd };
}

// Code points XML 1.0 forbids (control characters other than tab/newline/carriage return, unpaired surrogates, U+FFFE/U+FFFF).
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Escape special characters for XML content, dropping characters XML cannot hold so the workbook stays valid. */
export function escapeXml(str) {
  return String(str ?? '').replace(XML_INVALID, '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[c]);
}

/** Sanitize and limit Excel worksheet name to at most 31 characters without forbidden characters. */
export function sanitizeSheetName(name, fallback = 'Sheet1') {
  const clean = String(name || fallback)
    .replace(/[\\/?*[\]:]/g, '_')
    .trim();
  const truncated = clean.slice(0, 31).trim();
  return truncated || 'Sheet1';
}

/** 0-based column index to Excel column string (0 -> A, 25 -> Z, 26 -> AA). */
export function colName(c) {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const CURRENCY_AFFIX_RE = /(?:[A-Za-z]{1,3}\p{Sc}|\p{Sc}|[A-Z]{3}|[\u0621-\u064A]\.[\u0621-\u064A]\.?)/u;
const LEAD_AFFIX_RE = new RegExp(`^${CURRENCY_AFFIX_RE.source}\\s*`, 'u');
const TRAIL_AFFIX_RE = new RegExp(`\\s*${CURRENCY_AFFIX_RE.source}$`, 'u');
const GENERIC_LEAD_AFFIX_RE = /^[^\d\u0660-\u0669\u06F0-\u06F9+\-%.,\s]+\s*/;
const GENERIC_TRAIL_AFFIX_RE = /\s*[^\d\u0660-\u0669\u06F0-\u06F9+\-%.,\s]+$/;
const LEADING_ZERO_CODE_RE = /^[0\u0660\u06F0][0-9\u0660-\u0669\u06F0-\u06F9]/;

/** Parse an amount or numeric string into a JavaScript number, or null if not a numeric cell. */
export function parseCellNumber(val, { allowAnyCurrency = false } = {}) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val !== 'string') return null;
  let s = val.replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, '').trim();
  if (!s) return null;

  // Leading zero guard: codes like "01", "002", "٠١" stay text (unless "0" or "0.xx")
  if (LEADING_ZERO_CODE_RE.test(s)) return null;

  // Strip unconfigured currency warning suffix (English and Arabic)
  s = s.replace(/\s*\((?:currency not configured|عملة غير مضبوطة)\)\s*$/i, '').trim();

  // Accounting negative format: ($1,234.56), (1,234.56), (1,234.56 ﷼), etc.
  const parenMatch = s.match(/^\((.*)\)$/);
  if (parenMatch) {
    const inner = parseCellNumber(parenMatch[1], { allowAnyCurrency });
    return inner != null ? -Math.abs(inner) : null;
  }

  // Normalize Unicode minus \u2212
  s = s.replace(/\u2212/g, '-');

  // Extract sign only at start (never from inside codes/dates like "2026-01" or "1-30")
  let isNegative = false;
  let hasSign = false;
  if (s.startsWith('-') || s.startsWith('+')) {
    hasSign = true;
    isNegative = s.startsWith('-');
    s = s.slice(1).trim();
  }

  // Strip leading currency affix
  const leadRe = allowAnyCurrency ? GENERIC_LEAD_AFFIX_RE : LEAD_AFFIX_RE;
  const leadMatch = s.match(leadRe);
  if (leadMatch) {
    s = s.slice(leadMatch[0].length).trim();
  }

  // Support sign placed after leading currency affix (e.g., "SAR -1,234.56" or "$-12.50")
  if (!hasSign && (s.startsWith('-') || s.startsWith('+'))) {
    isNegative = s.startsWith('-');
    s = s.slice(1).trim();
  }

  // Strip trailing currency affix
  const trailRe = allowAnyCurrency ? GENERIC_TRAIL_AFFIX_RE : TRAIL_AFFIX_RE;
  const trailMatch = s.match(trailRe);
  if (trailMatch) {
    s = s.slice(0, s.length - trailMatch[0].length).trim();
  }

  // Recheck leading zero guard after stripping sign and affixes
  if (!s || LEADING_ZERO_CODE_RE.test(s)) return null;

  const num = parseAmount(s);
  if (!Number.isFinite(num)) return null;
  return isNegative ? -Math.abs(num) : num;
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="#,##0.00;(#,##0.00);&quot;-&quot;"/>
  </numFmts>
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
    <xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1">
    <cellStyle name="Normal" xfId="0" builtinId="0"/>
  </cellStyles>
</styleSheet>`;

function buildWorkbookXml(sheetName) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

/**
 * Extract 2D cell grid, merged ranges, and header count from a DOM table element.
 */
export function extractTableGrid(table) {
  if (!table) return { rows: [], merges: [], headerRowCount: 1, numericCols: new Set(), cellTypes: [] };
  const rows = [];
  const cellTypes = [];
  const merges = [];
  const occupied = new Set();
  const numericCols = new Set();
  let headerRowCount = 0;
  let maxCols = 0;
  const setCell = (r, c, value, isNum, isHeaderRow = false) => {
    while (rows.length <= r) rows.push([]);
    while (rows[r].length <= c) rows[r].push('');
    while (cellTypes.length <= r) cellTypes.push([]);
    while (cellTypes[r].length <= c) cellTypes[r].push(null);
    rows[r][c] = value;
    cellTypes[r][c] = isNum;
    if (!isHeaderRow && isNum) numericCols.add(c);
    if (c + 1 > maxCols) maxCols = c + 1;
  };

  const trs = tableRows(table);
  for (let rIdx = 0; rIdx < trs.length; rIdx += 1) {
    const tr = trs[rIdx];
    const cells = rowCells(tr);
    const isHeaderRow = (tr.parentElement ?? tr.parentNode)?.tagName?.toUpperCase() === 'THEAD'
      || (cells.length > 0 && cells.every((c) => c.tagName?.toUpperCase() === 'TH'));
    if (isHeaderRow) headerRowCount = Math.max(headerRowCount, rIdx + 1);

    let cIdx = 0;
    for (const cell of cells) {
      while (occupied.has(`${rIdx}:${cIdx}`)) cIdx += 1;
      const colSpan = Number(cell.colSpan || cell.getAttribute?.('colspan') || cell.getAttribute?.('colSpan')) || 1;
      const rowSpan = Number(cell.rowSpan || cell.getAttribute?.('rowspan') || cell.getAttribute?.('rowSpan')) || 1;
      const text = extractTableCellText(cell);
      const isNum = Boolean(cell.classList?.contains?.('num') || /\bnum\b/.test(cell.className || '') || cell.getAttribute?.('class')?.includes('num'));
      setCell(rIdx, cIdx, text, isNum, isHeaderRow);

      if (colSpan > 1 || rowSpan > 1) {
        const fromRef = `${colName(cIdx)}${rIdx + 1}`;
        const toRef = `${colName(cIdx + colSpan - 1)}${rIdx + rowSpan}`;
        merges.push(`${fromRef}:${toRef}`);
      }
      for (let rs = 0; rs < rowSpan; rs += 1) {
        for (let cs = 0; cs < colSpan; cs += 1) {
          occupied.add(`${rIdx + rs}:${cIdx + cs}`);
          if (rs > 0 || cs > 0) setCell(rIdx + rs, cIdx + cs, '', false, isHeaderRow);
        }
      }
      cIdx += colSpan;
    }
  }
  const normalized = rows.map((row) => Array.from({ length: maxCols }, (_, i) => row[i] ?? ''));
  const normalizedCellTypes = cellTypes.map((row) => Array.from({ length: maxCols }, (_, i) => row[i] ?? null));
  return {
    rows: normalized.length ? normalized : tableToRows(table),
    merges,
    headerRowCount: headerRowCount || 1,
    numericCols,
    cellTypes: normalizedCellTypes,
  };
}

function buildSheetXml(rows, { headerRowCount = 1, merges = [], columnTypes, cellTypes } = {}) {
  const rowXmls = rows.map((row, rIdx) => {
    const rNum = rIdx + 1;
    const isHeader = rIdx < headerRowCount;
    const cellXmls = [];
    for (let cIdx = 0; cIdx < row.length; cIdx += 1) {
      const val = row[cIdx];
      const ref = `${colName(cIdx)}${rNum}`;
      if (val === '' || val == null) {
        cellXmls.push(isHeader ? `<c r="${ref}" s="1"/>` : `<c r="${ref}"/>`);
        continue;
      }
      const isExplicitText = !isHeader && ((columnTypes && (columnTypes[cIdx] === 'text' || columnTypes[cIdx] === 'string')) || (cellTypes && cellTypes[rIdx]?.[cIdx] === false));
      const isExplicitNumber = !isHeader && ((columnTypes && columnTypes[cIdx] === 'number') || (cellTypes && cellTypes[rIdx]?.[cIdx] === true));
      const num = (isHeader || isExplicitText) ? null : parseCellNumber(val, { allowAnyCurrency: isExplicitNumber });
      if (num != null) {
        const styleId = isHeader ? 3 : 2;
        cellXmls.push(`<c r="${ref}" s="${styleId}"><v>${num}</v></c>`);
        continue;
      }
      const styleId = isHeader ? 1 : 0;
      const escaped = escapeXml(val);
      cellXmls.push(`<c r="${ref}"${styleId ? ` s="${styleId}"` : ''} t="inlineStr"><is><t>${escaped}</t></is></c>`);
    }
    return `    <row r="${rNum}">\n      ${cellXmls.join('\n      ')}\n    </row>`;
  });

  const mergeXml = merges.length > 0
    ? `\n  <mergeCells count="${merges.length}">\n    ${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('\n    ')}\n  </mergeCells>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
${rowXmls.join('\n')}
  </sheetData>${mergeXml}
</worksheet>`;
}

/**
 * Builds a valid store-only XLSX Uint8Array from a 2D array of rows or a DOM table.
 */
export function buildXlsx(data, options = {}) {
  let rows = [];
  let merges = options.merges ?? [];
  let headerRowCount = options.headerRowCount ?? 1;
  let cellTypes = options.cellTypes;
  let columnTypes = options.columnTypes;

  const tableElem = (options.table && (options.table.tagName || options.table.querySelector))
    ? options.table
    : (data && typeof data === 'object' && !Array.isArray(data) && (data.tagName || data.querySelector) ? data : null);

  if (tableElem) {
    const grid = extractTableGrid(tableElem);
    rows = grid.rows;
    merges = options.merges ?? grid.merges;
    headerRowCount = options.headerRowCount ?? grid.headerRowCount;
    if (grid.numericCols?.size) {
      cellTypes = options.cellTypes ?? grid.cellTypes;
      if (!columnTypes) {
        columnTypes = Array.from({ length: rows[0]?.length || 0 }, (_, i) => (grid.numericCols.has(i) ? 'number' : 'text'));
      }
    }
  } else if (typeof data === 'string') {
    rows = fromCsv(data);
  } else if (Array.isArray(data)) {
    rows = data;
  }

  const sheetName = sanitizeSheetName(options.sheetName || 'Sheet1');
  const files = {
    '[Content_Types].xml': CONTENT_TYPES_XML,
    '_rels/.rels': RELS_XML,
    'xl/_rels/workbook.xml.rels': WORKBOOK_RELS_XML,
    'xl/workbook.xml': buildWorkbookXml(sheetName),
    'xl/styles.xml': STYLES_XML,
    'xl/worksheets/sheet1.xml': buildSheetXml(rows, { headerRowCount, merges, columnTypes, cellTypes }),
  };

  return createZip(files);
}

/**
 * Parses rows, sheet name, and merged ranges from a generated XLSX byte buffer.
 */
export function readXlsx(bytes) {
  const { files } = parseZip(bytes);
  const workbookXml = files['xl/workbook.xml'] ? new TextDecoder().decode(files['xl/workbook.xml'].data) : '';
  const sheetMatch = workbookXml.match(/<sheet[^>]*name="([^"]+)"/);
  const sheetName = sheetMatch ? sheetMatch[1] : 'Sheet1';

  const sheetXml = files['xl/worksheets/sheet1.xml'] ? new TextDecoder().decode(files['xl/worksheets/sheet1.xml'].data) : '';
  const rows = [];
  const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/gi;
  const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi;

  let rowMatch;
  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[1];
    const rowCells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1] || cellMatch[3] || '';
      const body = cellMatch[2] || '';
      const refMatch = attrs.match(/r="([A-Z]+)(\d+)"/i);
      let colIdx = rowCells.length;
      if (refMatch) {
        const colLetters = refMatch[1].toUpperCase();
        let idx = 0;
        for (let i = 0; i < colLetters.length; i += 1) {
          idx = idx * 26 + (colLetters.charCodeAt(i) - 64);
        }
        colIdx = idx - 1;
      }
      let val = '';
      if (body.includes('<is><t>')) {
        const tMatch = body.match(/<is><t>([\s\S]*?)<\/t><\/is>/);
        val = tMatch ? decodeEntities(tMatch[1]) : '';
      } else if (body.includes('<v>')) {
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        const raw = vMatch ? vMatch[1] : '';
        const num = Number(raw);
        val = Number.isFinite(num) ? num : raw;
      }
      rowCells[colIdx] = val;
    }
    // Fill gaps
    for (let i = 0; i < rowCells.length; i += 1) {
      if (rowCells[i] === undefined) rowCells[i] = '';
    }
    rows.push(rowCells);
  }

  const merges = [];
  const mergeRegex = /<mergeCell\b[^>]*ref="([^"]+)"/gi;
  let mMatch;
  while ((mMatch = mergeRegex.exec(sheetXml)) !== null) {
    merges.push(mMatch[1]);
  }

  return { sheetName, rows, merges };
}

/**
 * Downloads data as a .xlsx file via downloadBlob helper from csv.js, returns generated bytes.
 */
export function downloadXlsx(filename, data, options = {}) {
  const bytes = buildXlsx(data, options);
  downloadBlob(filename, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return bytes;
}
