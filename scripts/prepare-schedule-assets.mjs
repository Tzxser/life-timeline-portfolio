// Bundle all OCR/PDF runtime data. Importing a document must never fetch a CDN.
import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const output = path.join(root, 'public', 'schedule-assets')
const packageRoot = name => path.dirname(require.resolve(`${name}/package.json`))
await fs.mkdir(path.join(output, 'ocr'), { recursive: true })
const workerSource = await fs.readFile(path.join(packageRoot('tesseract.js'), 'dist', 'worker.min.js'), 'utf8')
// The public bundle intentionally excludes dependency source maps. Removing
// the dangling reference keeps the offline worker self-contained and lets the
// public privacy audit reject unexpected source-map material consistently.
await fs.writeFile(path.join(output, 'ocr', 'worker.min.js'), workerSource.replace(/\r?\n\/\/[#@] sourceMappingURL=.*$/m, '\n'))
const core = path.dirname(createRequire(path.join(packageRoot('tesseract.js'), 'package.json')).resolve('tesseract.js-core/package.json'))
for (const name of await fs.readdir(core)) if (/^tesseract-core.*\.(?:wasm|js)$/.test(name)) await fs.copyFile(path.join(core, name), path.join(output, 'ocr', name))
for (const lang of ['chi_sim', 'eng']) {
  const folder = packageRoot(`@tesseract.js-data/${lang}`)
  const source = path.join(folder, '4.0.0_best_int', `${lang}.traineddata.gz`)
  await fs.copyFile(source, path.join(output, 'ocr', `${lang}.traineddata.gz`))
}
const pdf = packageRoot('pdfjs-dist')
await fs.mkdir(path.join(output, 'pdf'), { recursive: true })
await fs.copyFile(path.join(pdf, 'build', 'pdf.worker.min.mjs'), path.join(output, 'pdf', 'pdf.worker.min.mjs'))
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) await fs.cp(path.join(pdf, folder), path.join(output, 'pdf', folder), { recursive: true })
const licenses = path.join(output, 'licenses')
await fs.mkdir(licenses, { recursive: true })
for (const [label, directory] of [['tesseract.js', packageRoot('tesseract.js')], ['tesseract.js-core', core], ['pdfjs-dist', pdf]]) {
  for (const name of await fs.readdir(directory)) if (/^licen[cs]e|^notice/i.test(name)) await fs.copyFile(path.join(directory, name), path.join(licenses, `${label}-${name}`))
}
await fs.writeFile(path.join(licenses, 'language-data.txt'), 'Tesseract English and Simplified Chinese trained data: https://github.com/tesseract-ocr/tessdata_best\nDistributed under Apache License 2.0; see tesseract.js-core-LICENSE.\nBundled from @tesseract.js-data/eng and @tesseract.js-data/chi_sim 1.0.0.\n')
console.log('Local schedule OCR and PDF assets prepared.')
