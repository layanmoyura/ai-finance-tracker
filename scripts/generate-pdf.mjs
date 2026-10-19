import { existsSync, copyFileSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Ensure docs directory exists
const docsDir = resolve(rootDir, 'docs');
if (!existsSync(docsDir)) {
  mkdirSync(docsDir, { recursive: true });
}

const htmlSourcePath = resolve(rootDir, 'public', 'technical-docs.html');
const pdfTargetPath = resolve(docsDir, 'Apex_LifeOS_Technical_Documentation.pdf');
const publicPdfCopyPath = resolve(rootDir, 'public', 'Apex_LifeOS_Technical_Documentation.pdf');

if (!existsSync(htmlSourcePath)) {
  console.error(`[PDF Gen] Error: Source HTML not found at: ${htmlSourcePath}`);
  process.exit(1);
}

// Candidates for Chromium / Edge executable on Windows & POSIX
const browserCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'google-chrome',
  'chromium-browser',
  'chromium',
  'msedge',
];

let browserPath = browserCandidates.find((candidate) => existsSync(candidate));

if (!browserPath) {
  // If absolute path not found, try command in PATH
  for (const cmd of ['msedge', 'google-chrome', 'chromium']) {
    const probe = spawnSync(cmd, ['--version'], { shell: true, stdio: 'ignore' });
    if (probe.status === 0) {
      browserPath = cmd;
      break;
    }
  }
}

if (!browserPath) {
  console.error('[PDF Gen] No headless browser (Edge or Chrome) detected on this system.');
  process.exit(1);
}

console.log(`[PDF Gen] Using browser: ${browserPath}`);
console.log(`[PDF Gen] Source: ${htmlSourcePath}`);
console.log(`[PDF Gen] Target PDF: ${pdfTargetPath}`);

const fileUrl = pathToFileURL(htmlSourcePath).href;

const args = [
  '--headless',
  '--disable-gpu',
  '--run-all-compositor-stages-before-draw',
  '--no-pdf-header-footer',
  `--print-to-pdf=${pdfTargetPath}`,
  fileUrl,
];

console.log('[PDF Gen] Compiling technical documentation to PDF...');
const result = spawnSync(browserPath, args, {
  stdio: 'inherit',
  windowsHide: true,
});

if (result.status !== 0) {
  console.error(`[PDF Gen] Compilation failed with exit status ${result.status}`);
  process.exit(1);
}

if (existsSync(pdfTargetPath)) {
  const stats = statSync(pdfTargetPath);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`[PDF Gen] SUCCESS! Generated PDF (${sizeMb} MB) at:`);
  console.log(`  -> ${pdfTargetPath}`);

  // Copy to public folder for direct client download
  copyFileSync(pdfTargetPath, publicPdfCopyPath);
  console.log(`  -> Synced to public/ directory for direct web download.`);
} else {
  console.error('[PDF Gen] Target PDF file was not created.');
  process.exit(1);
}
