const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { findQemuBinary, findBaseImage, ensureEnvironmentReady } = require('./setup-environment');

class QemuController {
  constructor(config = {}) {
    this.config = {
      imagePath: config.imagePath || findBaseImage() || path.join(__dirname, '../../virium-base.qcow2'),
      qemuBinary: config.qemuBinary || findQemuBinary(),
      ramMB: config.ramMB || 2048,
      cpuCores: config.cpuCores || 2,
      cdpPort: config.cdpPort || 9222,
      qmpPort: config.qmpPort || 4444,
      headless: config.headless !== false,
      ...config
    };
    this.process = null;
    this.qmpSocket = null;
    this.qmpCallbacks = new Map();
    this.qmpSeq = 0;
    this.qmpBuffer = '';
  }

  async start() {
    await ensureEnvironmentReady();
    if (!this.config.imagePath || !fs.existsSync(this.config.imagePath)) {
      const env = await ensureEnvironmentReady();
      this.config.imagePath = env.imagePath;
    }

    const isWindows = process.platform === 'win32';
    const accel = isWindows ? 'whpx' : 'kvm';
    const qemuBin = this.config.qemuBinary || findQemuBinary();

    const args = [
      '-m', `${this.config.ramMB}M`,
      '-smp', `${this.config.cpuCores}`,
      '-accel', accel,
      '-drive', `file=${this.config.imagePath},if=virtio,snapshot=on`,
      '-netdev', `user,id=net0,hostfwd=tcp::${this.config.cdpPort}-:9222`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-qmp', `tcp:127.0.0.1:${this.config.qmpPort},server,nowait`,
      '-display', this.config.headless ? 'none' : 'sdl',
      '-vga', 'std'
    ];

    this.process = spawn(qemuBin, args, { stdio: 'ignore' });
    this.process.on('exit', (code) => {
      this.process = null;
    });

    await this.connectQmp();
    await this.waitForCDP();
  }

  async connectQmp() {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const tryConnect = () => {
        attempts++;
        if (attempts > 50) return reject(new Error('QMP connection timeout'));

        const sock = net.createConnection({ port: this.config.qmpPort, host: '127.0.0.1' }, () => {
          this.qmpSocket = sock;
          this.qmpSocket.on('data', (data) => this.handleQmpData(data));
          this.sendQmpCommand('qmp_capabilities').then(() => resolve()).catch(reject);
        });

        sock.on('error', () => {
          setTimeout(tryConnect, 100);
        });
      };
      tryConnect();
    });
  }

  handleQmpData(data) {
    this.qmpBuffer += data.toString();
    const lines = this.qmpBuffer.split('\r\n');
    this.qmpBuffer = lines.pop(); // Keep incomplete trailing line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && this.qmpCallbacks.has(msg.id)) {
          const cb = this.qmpCallbacks.get(msg.id);
          this.qmpCallbacks.delete(msg.id);
          if (msg.error) cb.reject(new Error(msg.error.desc || 'QMP Error'));
          else cb.resolve(msg.return);
        }
      } catch (err) {
        // Ignore non-json or banner lines
      }
    }
  }

  sendQmpCommand(execute, args = {}) {
    const id = ++this.qmpSeq;
    const payload = JSON.stringify({ execute, arguments: args, id }) + '\r\n';
    return new Promise((resolve, reject) => {
      this.qmpCallbacks.set(id, { resolve, reject });
      if (this.qmpSocket && !this.qmpSocket.destroyed) {
        this.qmpSocket.write(payload);
      } else {
        reject(new Error('QMP socket not connected'));
      }
    });
  }

  async saveSnapshot(name) {
    return this.sendQmpCommand('human-monitor-command', { 'command-line': `savevm ${name}` });
  }

  async loadSnapshot(name) {
    return this.sendQmpCommand('human-monitor-command', { 'command-line': `loadvm ${name}` });
  }

  async captureScreen(outputPath) {
    return this.sendQmpCommand('screendump', { filename: outputPath });
  }

  async switchDisplayToHeadful(handoffTag = 'handoff_temp') {
    await this.saveSnapshot(handoffTag);
    await this.stop();

    this.config.headless = false;
    const isWindows = process.platform === 'win32';
    const accel = isWindows ? 'whpx' : 'kvm';

    const args = [
      '-m', `${this.config.ramMB}M`,
      '-smp', `${this.config.cpuCores}`,
      '-accel', accel,
      '-drive', `file=${this.config.imagePath},if=virtio`,
      '-netdev', `user,id=net0,hostfwd=tcp::${this.config.cdpPort}-:9222`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-qmp', `tcp:127.0.0.1:${this.config.qmpPort},server,nowait`,
      '-display', 'sdl',
      '-loadvm', handoffTag
    ];

    this.process = spawn('qemu-system-x86_64', args, { stdio: 'inherit' });
    await this.connectQmp();
    await this.waitForCDP();
  }

  async switchDisplayToHeadless(handoffTag = 'handoff_return') {
    await this.saveSnapshot(handoffTag);
    await this.stop();
    this.config.headless = true;
    await this.start();
    await this.loadSnapshot(handoffTag);
  }

  async waitForCDP() {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.config.cdpPort}/json/version`);
        if (res.ok) return;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Chromium CDP failed to initialize on port ' + this.config.cdpPort);
  }

  async stop() {
    if (this.qmpSocket) {
      try {
        await this.sendQmpCommand('quit');
      } catch (_) {}
      this.qmpSocket.destroy();
      this.qmpSocket = null;
    }
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
  }
}

module.exports = { QemuController };
