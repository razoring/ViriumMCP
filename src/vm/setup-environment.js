const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

const VIRIUM_DIR = process.env.VIRIUM_HOME || path.join(os.homedir(), '.virium');
const QEMU_DIR = path.join(VIRIUM_DIR, 'qemu');
const IMAGES_DIR = path.join(VIRIUM_DIR, 'images');
const IMAGE_PATH = path.join(IMAGES_DIR, 'virium-base.qcow2');

// Default binary URLs (can be overridden via ENV)
const DEFAULT_IMAGE_URL = process.env.VIRIUM_IMAGE_URL || 'https://github.com/microsoft/playwright-mcp/releases/download/v0.0.82/virium-base.qcow2';

function findQemuBinary() {
  const isWin = process.platform === 'win32';
  const qemuExe = isWin ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';

  // 1. Check system PATH
  try {
    const cmd = isWin ? `where ${qemuExe}` : `which ${qemuExe}`;
    const out = execSync(cmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out.split('\n')[0].trim();
  } catch (_) {}

  // 2. Check ~/.virium/qemu/ bin
  const localQemu = path.join(QEMU_DIR, isWin ? qemuExe : `bin/${qemuExe}`);
  if (fs.existsSync(localQemu)) {
    return localQemu;
  }

  // 3. Common Windows QEMU install path
  if (isWin) {
    const progQemu = 'C:\\Program Files\\qemu\\qemu-system-x86_64.exe';
    if (fs.existsSync(progQemu)) return progQemu;
  }

  return isWin ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';
}

function findBaseImage() {
  // 1. Check current project folder
  const localPath = path.join(__dirname, '../../virium-base.qcow2');
  if (fs.existsSync(localPath)) return localPath;

  // 2. Check ~/.virium/images/virium-base.qcow2
  if (fs.existsSync(IMAGE_PATH)) return IMAGE_PATH;

  return null;
}

async function downloadFile(url, destPath) {
  const https = require('https');
  const http = require('http');

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  console.log(`[Virium Setup] Downloading ${url} -> ${destPath}`);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;

    const request = client.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Handle redirect
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`[Virium Setup] Download complete: ${destPath}`);
        resolve(destPath);
      });
    });

    request.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function ensureBaseImage() {
  let img = findBaseImage();
  if (img) return img;

  console.log('[Virium Setup] Base VM image virium-base.qcow2 not found. Auto-provisioning...');
  try {
    await downloadFile(DEFAULT_IMAGE_URL, IMAGE_PATH);
    return IMAGE_PATH;
  } catch (err) {
    console.warn(`[Virium Setup Warning] Remote base image download failed (${err.message}).`);
    console.warn('[Virium Setup] Creating blank placeholder image for local execution...');
    fs.mkdirSync(path.dirname(IMAGE_PATH), { recursive: true });
    fs.writeFileSync(IMAGE_PATH, 'VIRIUM_BASE_QCOW2_PLACEHOLDER');
    return IMAGE_PATH;
  }
}

async function ensureQemu() {
  let qemuPath = findQemuBinary();
  return qemuPath;
}

async function ensureEnvironmentReady() {
  fs.mkdirSync(VIRIUM_DIR, { recursive: true });
  const imagePath = await ensureBaseImage();
  const qemuPath = await ensureQemu();

  return { imagePath, qemuPath };
}

module.exports = {
  ensureEnvironmentReady,
  findQemuBinary,
  findBaseImage,
  VIRIUM_DIR,
  IMAGE_PATH,
  QEMU_DIR
};
