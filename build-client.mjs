import { readFile, writeFile } from 'node:fs/promises'

const source = await readFile(new URL('./client.source.js', import.meta.url), 'utf8')
const vendor = await readFile(new URL('./marked.umd.js', import.meta.url), 'utf8')
const renderer = (await readFile(new URL('./markdown-renderer.js', import.meta.url), 'utf8')).replace('export function renderMarkdown', 'function renderMarkdown')
const marker = '    /*__MARKDOWN_BUILD__*/'
if (source.split(marker).length !== 2) throw new Error('客户端构建标记必须恰好出现一次')
const bundled = `    const marked = (() => { const module = { exports: {} }; const exports = module.exports;\n${vendor}\nreturn module.exports.marked })()\n${renderer}`
const output = source.replace(marker, bundled)
const target = new URL('./client.js', import.meta.url)
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('client.js 与渲染源码不一致，请运行 node build-client.mjs')
} else await writeFile(target, output)
