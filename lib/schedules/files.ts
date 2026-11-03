import { parseJson, parseMatrix, parseOcr, parseText, type OcrWord, type ParsedSchedule } from './parse'

export const SCHEDULE_ACCEPT = '.txt,.md,.csv,.tsv,.json,.html,.htm,.docx,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,.bmp'
export interface ScheduleFileResult extends ParsedSchedule { name: string; images: Array<{ mimeType: string; base64: string }>; method: string }
const MAX_FILE = 16 * 1024 * 1024
const MAX_TEXT = 500_000
const ASSETS = '/schedule-assets'
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('已取消本地识别', 'AbortError') }

function imageData(canvas: HTMLCanvasElement) {
  return { mimeType: 'image/jpeg', base64: canvas.toDataURL('image/jpeg', .88).split(',')[1] }
}
async function ocr(canvas: HTMLCanvasElement, progress: (value: string) => void, signal?: AbortSignal): Promise<ParsedSchedule> {
  const { createWorker, OEM, PSM } = await import('tesseract.js')
  abort(signal)
  progress('正在启动本机中英文图片识别…')
  const worker = await createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
    workerPath: `${ASSETS}/ocr/worker.min.js`, corePath: `${ASSETS}/ocr`, langPath: `${ASSETS}/ocr`, workerBlobURL: false,
    logger: message => { if (message.status === 'recognizing text') progress(`正在本机识别图片 ${Math.round(message.progress * 100)}%…`) },
  })
  const cancel = () => { void worker.terminate() }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    abort(signal)
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO })
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true })
    abort(signal)
    const words: OcrWord[] = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)))
    const result = parseOcr(words, data.text, canvas.width, canvas.height)
    if (data.confidence < 65) result.warnings.push('部分图片文字置信度较低，请核对原文或选择 AI 辅助整理。')
    return result
  } finally { signal?.removeEventListener('abort', cancel); await worker.terminate() }
}
async function imageCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file)
  try {
    if (bitmap.width * bitmap.height > 30_000_000) throw new Error('图片像素过大，请分成几张图片后导入。')
    const scale = Math.min(2, 2600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
    const context = canvas.getContext('2d')!
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally { bitmap.close() }
}
async function safeOcr(canvas: HTMLCanvasElement, progress: (value: string) => void, signal?: AbortSignal): Promise<ParsedSchedule> {
  try { return await ocr(canvas, progress, signal) }
  catch (error) {
    abort(signal)
    return { entries: [], text: '', warnings: [`本地图片识别未完成：${error instanceof Error ? error.message : '识别失败'}。图片已保留在本次预览中，可选择 AI 辅助或手动填写。`] }
  }
}
function parseDelimited(text: string, delimiter: string): unknown[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++ } else quoted = !quoted }
    else if (c === delimiter && !quoted) { row.push(cell); cell = '' }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (quoted) throw new Error('表格中有未闭合的引号，请检查 CSV 文件。')
  row.push(cell); if (row.some(Boolean)) rows.push(row)
  if (rows.length > 5000 || rows.some(r => r.length > 100)) throw new Error('表格过大，请按学期或日期分批导入。')
  return rows
}
async function checkZip(bytes: Uint8Array, wanted?: string) {
  const { unzipSync } = await import('fflate')
  let total = 0, count = 0
  return unzipSync(bytes, { filter: entry => {
    total += entry.originalSize; count++
    if (total > 80 * 1024 * 1024 || count > 6000 || entry.originalSize > 30 * 1024 * 1024) throw new Error('文档展开后过大，请拆分后导入。')
    return wanted === undefined || wanted === entry.name
  } })
}
async function readDocx(bytes: Uint8Array): Promise<ParsedSchedule> {
  const zip = await checkZip(bytes, 'word/document.xml')
  if (!zip['word/document.xml']) throw new Error('没有找到 Word 正文，请使用未加密的 DOCX 文件。')
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(zip['word/document.xml']), 'application/xml')
  if (xml.querySelector('parsererror')) throw new Error('Word 正文格式损坏。')
  const all = (node: Element | Document, tag: string) => [...node.getElementsByTagNameNS('*', tag)]
  const textIn = (node: Element) => all(node, 't').map(t => t.textContent ?? '').join('')
  const tables = all(xml, 'tbl').map(table => all(table, 'tr').map(row => all(row, 'tc').map(cell => all(cell, 'p').map(textIn).join('\n'))))
  const paragraphs = all(xml, 'p').filter(p => { let parent = p.parentElement; while (parent) { if (parent.localName === 'tbl') return false; parent = parent.parentElement } return true }).map(textIn).join('\n')
  const parts = [...tables.map(parseMatrix), parseText(paragraphs)]
  return { entries: parts.flatMap(p => p.entries), warnings: parts.filter(p => p.text.trim()).flatMap(p => p.warnings), text: parts.map(p => p.text).join('\n\n') }
}

/**
 * Read the small, XML-based part of an XLSX directly.  ExcelJS is useful for
 * ordinary workbooks, but some spreadsheet exporters put the OOXML namespace
 * on every element (for example `<x:workbook>`).  The ExcelJS XML reader
 * rejects that otherwise valid file.  Keeping this reader here also means the
 * import remains local and does not require a server-side spreadsheet parser.
 */
async function readXlsxXml(bytes: Uint8Array): Promise<ParsedSchedule> {
  if (typeof DOMParser === 'undefined') throw new Error('当前环境没有本地 XML 解析器。')
  const zip = await checkZip(bytes)
  const decoder = new TextDecoder('utf-8')
  const xml = (name: string) => {
    const data = zip[name]
    if (!data) throw new Error(`XLSX 缺少 ${name}。`)
    const document = new DOMParser().parseFromString(decoder.decode(data), 'application/xml')
    if (document.getElementsByTagName('parsererror').length) throw new Error(`XLSX 中的 ${name} 格式损坏。`)
    return document
  }
  const elements = (node: Element | Document, localName: string): Element[] => Array.from(node.getElementsByTagNameNS('*', localName))
  const attr = (node: Element, name: string) => {
    const direct = node.getAttribute(name)
    if (direct !== null) return direct
    for (let i = 0; i < node.attributes.length; i++) {
      const candidate = node.attributes.item(i)
      if (candidate?.localName === name) return candidate.value
    }
    return ''
  }
  const first = (node: Element | Document, localName: string) => elements(node, localName)[0]
  const normaliseZipPath = (base: string, target: string) => {
    const raw = target.startsWith('/') ? target.slice(1) : `${base.slice(0, base.lastIndexOf('/') + 1)}${target}`
    const parts: string[] = []
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') { parts.pop(); continue }
      parts.push(part)
    }
    return parts.join('/')
  }
  const workbookName = 'xl/workbook.xml'
  const workbook = xml(workbookName)
  const relationshipsName = 'xl/_rels/workbook.xml.rels'
  const relationships = xml(relationshipsName)
  const sheetTargets = new Map<string, string>()
  for (const relationship of elements(relationships, 'Relationship')) {
    const type = attr(relationship, 'Type')
    if (!/\/worksheet$/i.test(type)) continue
    const id = attr(relationship, 'Id')
    const target = normaliseZipPath('xl/workbook.xml', attr(relationship, 'Target'))
    if (id && target && zip[target]) sheetTargets.set(id, target)
  }
  const shared: string[] = []
  const sharedData = zip['xl/sharedStrings.xml']
  if (sharedData) {
    const sharedDocument = new DOMParser().parseFromString(decoder.decode(sharedData), 'application/xml')
    if (sharedDocument.getElementsByTagName('parsererror').length) throw new Error('XLSX 的共享字符串格式损坏。')
    for (const item of elements(sharedDocument, 'si')) shared.push(elements(item, 't').map(t => t.textContent ?? '').join(''))
  }
  const columnNumber = (address: string) => {
    const match = address.match(/^([A-Za-z]+)(\d+)$/)
    if (!match) return undefined
    let result = 0
    for (const character of match[1].toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64
    const row = Number(match[2])
    return Number.isInteger(row) && row > 0 && result > 0 ? { row, column: result } : undefined
  }
  const range = (value: string) => {
    const parts = value.split(':').map(columnNumber)
    if (!parts[0] || !parts[1]) return undefined
    return {
      top: Math.min(parts[0].row, parts[1].row), bottom: Math.max(parts[0].row, parts[1].row),
      left: Math.min(parts[0].column, parts[1].column), right: Math.max(parts[0].column, parts[1].column),
    }
  }
  const cellText = (cell: Element, type: string, value: string) => {
    if (type === 's') {
      const index = Number(value)
      return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : value
    }
    if (type === 'inlineStr') return elements(cell, 't').map(t => t.textContent ?? '').join('')
    if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
    return value
  }
  const parseSheet = (name: string): string[][] => {
    const sheet = xml(name)
    const rows: string[][] = []
    let maxColumn = 0
    for (const rowNode of elements(sheet, 'row')) {
      const rowNumber = Number(attr(rowNode, 'r')) || rows.length + 1
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 5000) throw new Error('表格过大，请按学期或日期分批导入。')
      const row: string[] = rows[rowNumber - 1] ?? []
      let inferredColumn = 0
      for (const cell of elements(rowNode, 'c')) {
        const address = attr(cell, 'r')
        const location = address ? columnNumber(address) : undefined
        const column = location?.column ?? inferredColumn + 1
        if (column > 100) throw new Error('表格过大，请按学期或日期分批导入。')
        inferredColumn = column
        const valueNode = first(cell, 'v')
        const value = cellText(cell, attr(cell, 't'), valueNode?.textContent ?? '')
        row[column - 1] = value
        maxColumn = Math.max(maxColumn, column)
      }
      rows[rowNumber - 1] = row
    }
    if (rows.length > 5000 || maxColumn > 100) throw new Error('表格过大，请按学期或日期分批导入。')
    for (const merge of elements(sheet, 'mergeCell')) {
      const cells = range(attr(merge, 'ref'))
      if (!cells || cells.bottom > 5000 || cells.right > 100 || (cells.bottom - cells.top + 1) * (cells.right - cells.left + 1) > 100_000) throw new Error('表格合并范围过大，请拆分后导入。')
      // A one-row merge is usually a title, subtitle, or footer. Repeating
      // that prose into every weekday column would make parseMatrix treat it
      // as one course per day. Vertical merges commonly mean one course
      // occupies several consecutive periods, so retain those.
      if (cells.bottom === cells.top) continue
      const value = rows[cells.top - 1]?.[cells.left - 1] ?? ''
      if (!value) continue
      for (let row = cells.top; row <= cells.bottom; row++) {
        const values = rows[row - 1] ?? (rows[row - 1] = [])
        for (let column = cells.left; column <= cells.right; column++) if (!values[column - 1]) values[column - 1] = value
      }
    }
    return rows.map(row => Array.from({ length: maxColumn }, (_, index) => row?.[index] ?? ''))
  }
  const sheets = elements(workbook, 'sheet')
  if (!sheets.length) throw new Error('XLSX 中没有工作表。')
  const parts = sheets.map((sheet, index) => {
    const relationship = attr(sheet, 'id')
    const target = sheetTargets.get(relationship) ?? `xl/worksheets/sheet${index + 1}.xml`
    if (!zip[target]) throw new Error(`找不到工作表 ${attr(sheet, 'name') || index + 1}。`)
    return parseMatrix(parseSheet(target))
  })
  return { entries: parts.flatMap(part => part.entries), warnings: parts.flatMap(part => part.warnings), text: parts.map(part => part.text).join('\n\n') }
}
async function readXlsx(bytes: Uint8Array): Promise<ParsedSchedule> {
  await checkZip(bytes)
  try {
    const Excel = await import('exceljs')
    const workbook = new Excel.Workbook()
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    const parts: ParsedSchedule[] = []
    workbook.eachSheet(sheet => {
      if (sheet.rowCount > 5000 || sheet.columnCount > 100) throw new Error('表格过大，请按学期或日期分批导入。')
      const matrix: string[][] = []
      sheet.eachRow({ includeEmpty: true }, row => {
        const cells: string[] = []
        for (let c = 1; c <= Math.min(sheet.columnCount, 100); c++) {
          const cell = row.getCell(c)
          cells.push(cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : cell.text)
        }
        matrix.push(cells)
      })
      parts.push(parseMatrix(matrix))
    })
    return { entries: parts.flatMap(p => p.entries), warnings: parts.flatMap(p => p.warnings), text: parts.map(p => p.text).join('\n\n') }
  } catch {
    return readXlsxXml(bytes)
  }
}
async function readPdf(bytes: Uint8Array, progress: (value: string) => void, signal?: AbortSignal) {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = `${ASSETS}/pdf/pdf.worker.min.mjs`
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true, cMapUrl: `${ASSETS}/pdf/cmaps/`, cMapPacked: true, standardFontDataUrl: `${ASSETS}/pdf/standard_fonts/`, wasmUrl: `${ASSETS}/pdf/wasm/` })
  const cancel = () => { void task.destroy() }; signal?.addEventListener('abort', cancel, { once: true })
  const parts: ParsedSchedule[] = [], images: ScheduleFileResult['images'] = []
  try {
    const document = await task.promise
    if (document.numPages > 20) throw new Error('PDF 超过 20 页，请先按日程所在页拆分。')
    for (let n = 1; n <= document.numPages; n++) {
      abort(signal); progress(`正在本机读取 PDF 第 ${n}/${document.numPages} 页…`)
      const page = await document.getPage(n)
      const content = await page.getTextContent()
      let text = ''
      for (const item of content.items) if ('str' in item) text += `${item.str}${item.hasEOL ? '\n' : ' '}`
      let part = parseText(text)
      if (part.entries.length === 0) {
        const viewport = page.getViewport({ scale: Math.min(2, 2200 / page.getViewport({ scale: 1 }).width) })
        const canvas = window.document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height
        await page.render({ canvas, viewport }).promise
        part = await safeOcr(canvas, progress, signal)
        if (images.length < 4) images.push(imageData(canvas))
        canvas.width = 0; canvas.height = 0
      }
      parts.push(part); page.cleanup()
    }
  } finally { signal?.removeEventListener('abort', cancel); await task.destroy() }
  return { entries: parts.flatMap(p => p.entries), warnings: parts.flatMap(p => p.warnings), text: parts.map(p => p.text).join('\n\n'), images }
}
export async function readScheduleFile(file: File, progress: (value: string) => void, signal?: AbortSignal): Promise<ScheduleFileResult> {
  if (file.size === 0 || file.size > MAX_FILE) throw new Error('请选择非空文件，单个文件不超过 16 MB。')
  abort(signal)
  const ext = file.name.split('.').at(-1)?.toLowerCase()
  let parsed: ParsedSchedule, images: ScheduleFileResult['images'] = [], method = '本地文档解析'
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext || '')) {
    const canvas = await imageCanvas(file); images = [imageData(canvas)]; method = '本地中英文图片识别'
    try { parsed = await safeOcr(canvas, progress, signal) } finally { canvas.width = 0; canvas.height = 0 }
  } else {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (ext === 'xlsx') parsed = await readXlsx(bytes)
    else if (ext === 'docx') parsed = await readDocx(bytes)
    else if (ext === 'pdf') { const pdf = await readPdf(bytes, progress, signal); parsed = pdf; images = pdf.images }
    else {
      let text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
      if (text.includes('\uFFFD')) text = new TextDecoder('gb18030').decode(bytes)
      if (text.length > MAX_TEXT) throw new Error('文字内容过长，请分批导入。')
      if (ext === 'json') parsed = parseJson(text)
      else if (ext === 'csv' || ext === 'tsv') parsed = parseMatrix(parseDelimited(text, ext === 'tsv' ? '\t' : ','))
      else if (ext === 'html' || ext === 'htm') {
        const doc = new DOMParser().parseFromString(text, 'text/html')
        doc.querySelectorAll('script,style,iframe,object').forEach(node => node.remove())
        const tables = [...doc.querySelectorAll('table')].map(table => parseMatrix([...table.rows].map(row => [...row.cells].map(cell => cell.textContent || ''))))
        parsed = tables.length ? { entries: tables.flatMap(p => p.entries), warnings: tables.flatMap(p => p.warnings), text: tables.map(p => p.text).join('\n') } : parseText(doc.body.textContent || '')
      } else if (ext === 'txt' || ext === 'md') parsed = parseText(text)
      else throw new Error('暂不支持这个文件容器。请另存为 TXT、DOCX、XLSX、CSV、JSON、PDF 或清晰图片后导入。')
    }
  }
  abort(signal)
  if (parsed.entries.length > 4000 || parsed.text.length > MAX_TEXT) throw new Error('日程内容过多，请分批导入。')
  return { ...parsed, name: file.name, images, method }
}
