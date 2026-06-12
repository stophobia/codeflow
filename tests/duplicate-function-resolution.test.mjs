import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const htmlSource = await readFile(join(repoRoot, 'index.html'), 'utf8');
const startMarker = '// ===== CODEFLOW_ANALYZER_START =====';
const endMarker = '// ===== CODEFLOW_ANALYZER_END =====';
const parserStart = htmlSource.indexOf(startMarker);
const parserEnd = htmlSource.indexOf(endMarker, parserStart);

if (parserStart < 0 || parserEnd < 0) {
  throw new Error('Could not locate analyzer source in index.html');
}

const context = {
  console,
  TreeSitter: undefined,
  Babel: undefined,
  acorn: undefined,
  getSecurityScanContent(file) {
    return file && file.content ? file.content : '';
  },
  isSanitizedPreviewRenderer() {
    return false;
  },
};

vm.createContext(context);
vm.runInContext(`${htmlSource.slice(parserStart, parserEnd)}\nthis.Parser = Parser; this.buildAnalysisData = buildAnalysisData;`, context);

const { Parser, buildAnalysisData } = context;

function makeAnalyzedFile(path, content) {
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'root';
  const functions = Parser.extract(content, path);
  return {
    path,
    name: basename(path),
    folder,
    content,
    functions,
    lines: content.split('\n').length,
    layer: Parser.detectLayer(path),
    churn: 0,
    isCode: true,
  };
}

async function analyze(files) {
  const analyzed = files.map((file) => makeAnalyzedFile(file.path, file.content));
  const allFns = [];
  analyzed.forEach((file) => {
    file.functions.forEach((fn) => {
      allFns.push(Object.assign({}, fn, { folder: file.folder, layer: file.layer }));
    });
  });
  return buildAnalysisData({
    analyzed,
    allFns,
    excludePatterns: [],
    progress() {},
    yieldFn: async () => {},
  });
}

test('same-name functions in unrelated files do not create cross-file graph edges', async () => {
  const data = await analyze([
    {
      path: 'src/a.js',
      content: 'export function Keys() {\n  return "a";\n}\n',
    },
    {
      path: 'src/b.js',
      content: 'export function Keys() {\n  return "b";\n}\n\nexport function useB() {\n  return Keys();\n}\n',
    },
  ]);

  assert.equal(data.connections.some((conn) => conn.fn === 'Keys'), false);

  const stats = Object.values(data.fnStats).filter((stat) => stat.name === 'Keys');
  assert.equal(stats.length, 2);
  assert.equal(stats.find((stat) => stat.file === 'src/a.js').external, 0);
  assert.equal(stats.find((stat) => stat.file === 'src/b.js').internal > 0, true);
});

test('same-name cross-file calls resolve to the explicitly imported definition', async () => {
  const data = await analyze([
    {
      path: 'src/a.js',
      content: 'export function Keys() {\n  return "a";\n}\n',
    },
    {
      path: 'src/b.js',
      content: 'export function Keys() {\n  return "b";\n}\n',
    },
    {
      path: 'src/c.js',
      content: 'import { Keys } from "./a.js";\n\nexport function useImported() {\n  return Keys();\n}\n',
    },
  ]);

  assert.equal(data.connections.some((conn) => conn.source === 'src/a.js' && conn.target === 'src/c.js' && conn.fn === 'Keys'), true);
  assert.equal(data.connections.some((conn) => conn.source === 'src/b.js' && conn.target === 'src/c.js' && conn.fn === 'Keys'), false);

  const importedStat = Object.values(data.fnStats).find((stat) => stat.name === 'Keys' && stat.file === 'src/a.js');
  const unrelatedStat = Object.values(data.fnStats).find((stat) => stat.name === 'Keys' && stat.file === 'src/b.js');
  assert.equal(importedStat.external > 0, true);
  assert.equal(unrelatedStat.external, 0);
});
