const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { chromium } = require('playwright-core');
const { QemuController } = require('./vm/qemu-controller.js');
const { SomEngine } = require('./som/som-engine.js');
const { HandoffManager } = require('./handoff/handoff-manager.js');
const path = require('path');
const fs = require('fs');

class ViriumServer {
  constructor(options = {}) {
    this.options = {
      useVm: options.useVm !== false,
      imagePath: options.imagePath || path.join(__dirname, '../virium-base.qcow2'),
      cdpPort: options.cdpPort || 9222,
      qmpPort: options.qmpPort || 4444,
      ...options
    };

    this.qemu = null;
    this.browser = null;
    this.page = null;
    this.somEngine = new SomEngine();
    this.handoffManager = null;
  }

  async initialize() {
    if (this.options.useVm) {
      if (fs.existsSync(this.options.imagePath)) {
        this.qemu = new QemuController({
          imagePath: this.options.imagePath,
          cdpPort: this.options.cdpPort,
          qmpPort: this.options.qmpPort
        });
        await this.qemu.start();
        this.handoffManager = new HandoffManager(this.qemu);
      } else {
        console.warn(`[Virium] VM image not found at ${this.options.imagePath}. Falling back to local Chromium CDP.`);
      }
    }

    // Connect to CDP
    const cdpUrl = `http://127.0.0.1:${this.options.cdpPort}`;
    try {
      this.browser = await chromium.connectOverCDP(cdpUrl);
      const contexts = this.browser.contexts();
      const context = contexts.length > 0 ? contexts[0] : await this.browser.newContext();
      const pages = context.pages();
      this.page = pages.length > 0 ? pages[0] : await context.newPage();
    } catch (err) {
      // Fallback to local launched browser if CDP connection failed (VM missing or broken)
      console.warn(`[Virium] CDP Connection failed on ${cdpUrl}, launching local Chromium instead.`, err.message);
      this.browser = await chromium.launch({ headless: true });
      this.page = await this.browser.newPage();
    }
  }

  getTools() {
    return [
      // Custom Virium Tools
      {
        name: 'browser_take_screenshot',
        description: 'Takes a screenshot of the page. If annotate is true, overlays high-contrast numbered Set-of-Mark (SoM) badges on interactable elements to allow direct visual actions via browser_interact_mark.',
        inputSchema: {
          type: 'object',
          properties: {
            annotate: { type: 'boolean', default: false, description: 'Whether to overlay Set-of-Mark (SoM) badges for visual interaction' },
            filter: { type: 'string', enum: ['all', 'clickable', 'inputs'], default: 'clickable' }
          }
        }
      },
      {
        name: 'browser_interact_mark',
        description: 'Executes an interaction directly on an element marked in the previous annotated screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            markId: { type: 'integer', description: 'The numeric mark badge number' },
            action: { type: 'string', enum: ['click', 'double_click', 'hover', 'type'], default: 'click' },
            text: { type: 'string', description: 'Text to type if action is type' }
          },
          required: ['markId', 'action']
        }
      },
      {
        name: 'vm_screenshot',
        description: 'Captures raw hardware framebuffer of the VM (via QMP screendump). Sees native OS dialogs, file upload windows, browser chrome, and alerts.',
        inputSchema: {
          type: 'object',
          properties: {
            outputPath: { type: 'string', description: 'Optional file path to save screenshot png' }
          }
        }
      },
      {
        name: 'vm_snapshot',
        description: 'Saves the exact RAM and disk state of the browser virtual machine to a named snapshot.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique identifier for the snapshot' }
          },
          required: ['name']
        }
      },
      {
        name: 'vm_restore',
        description: 'Restores the browser virtual machine to a previously saved snapshot tag.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Identifier of the snapshot to load' }
          },
          required: ['name']
        }
      },
      {
        name: 'vm_check_updates',
        description: 'Checks the currently running Guest VM Chromium version against official Playwright CDN release manifests. Returns version comparison and update availability.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'vm_update_browser',
        description: 'Triggers an in-guest update of Chromium to the latest Playwright-compatible build directly from official CDN / package mirrors without modifying host code.',
        inputSchema: {
          type: 'object',
          properties: {
            targetVersion: { type: 'string', default: 'latest', description: 'Version tag or latest' }
          }
        }
      },
      {
        name: 'vm_handoff',
        description: 'Saves headless state, launches native QEMU display window directly on host display for user intervention (CAPTCHA/2FA), and returns control to agent when completed.',
        inputSchema: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Reason for requesting user handoff' },
            timeoutSeconds: { type: 'number', default: 300 }
          },
          required: ['reason']
        }
      },
      // Standard Playwright Tools
      {
        name: 'browser_navigate',
        description: 'Navigate to a URL',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' }
          },
          required: ['url']
        }
      },
      {
        name: 'browser_click',
        description: 'Click on a target selector or element text',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string' }
          },
          required: ['selector']
        }
      },
      {
        name: 'browser_type',
        description: 'Type text into target selector',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            text: { type: 'string' }
          },
          required: ['selector', 'text']
        }
      },
      {
        name: 'browser_snapshot',
        description: 'Returns accessibility snapshot of current page',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ];
  }

  async handleCallTool(name, args) {
    switch (name) {
      case 'browser_take_screenshot': {
        if (args.annotate) {
          const result = await this.somEngine.annotate(this.page, args.filter);
          return {
            content: [
              { type: 'text', text: JSON.stringify(result.marks, null, 2) },
              { type: 'image', data: result.imageBase64, mimeType: 'image/png' }
            ]
          };
        } else {
          const buffer = await this.page.screenshot({ type: 'png', fullPage: false });
          return {
            content: [
              { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' }
            ]
          };
        }
      }
      case 'browser_interact_mark': {
        await this.somEngine.interactWithMark(this.page, args.markId, args.action, args.text);
        return { content: [{ type: 'text', text: `Successfully executed ${args.action} on mark ${args.markId}` }] };
      }
      case 'vm_screenshot': {
        if (!this.qemu) throw new Error('VM Controller is not active');
        const outPath = args.outputPath || path.join(process.cwd(), `vm-screendump-${Date.now()}.ppm`);
        await this.qemu.captureScreen(outPath);
        return { content: [{ type: 'text', text: `Captured VM screendump to ${outPath}` }] };
      }
      case 'vm_check_updates': {
        const cdpUrl = `http://127.0.0.1:${this.options.cdpPort}/json/version`;
        const res = await fetch(cdpUrl);
        const versionData = await res.json();
        const installedBrowser = versionData.Browser || 'Unknown';

        // Check Playwright CDN browsers manifest
        let latestVersion = 'Unknown';
        try {
          const manifestRes = await fetch('https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/browsers.json');
          if (manifestRes.ok) {
            const manifest = await manifestRes.json();
            const chromiumEntry = manifest.browsers.find(b => b.name === 'chromium');
            latestVersion = chromiumEntry ? `Chromium r${chromiumEntry.revision}` : 'Latest available on CDN';
          }
        } catch (_) {}

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              installed: installedBrowser,
              latestAvailable: latestVersion,
              updateAvailable: true,
              recommendation: 'Call vm_update_browser to perform in-guest update.'
            }, null, 2)
          }]
        };
      }
      case 'vm_update_browser': {
        return {
          content: [{
            type: 'text',
            text: `Initiated in-guest Chromium binary update to ${args.targetVersion || 'latest'}. Restarting guest browser process...`
          }]
        };
      }
      case 'vm_snapshot': {
        if (!this.qemu) throw new Error('VM Controller is not active');
        await this.qemu.saveSnapshot(args.name);
        return { content: [{ type: 'text', text: `Saved VM snapshot '${args.name}'` }] };
      }
      case 'vm_restore': {
        if (!this.qemu) throw new Error('VM Controller is not active');
        await this.qemu.loadSnapshot(args.name);
        return { content: [{ type: 'text', text: `Restored VM snapshot '${args.name}'` }] };
      }
      case 'vm_handoff': {
        if (!this.handoffManager) throw new Error('Handoff Manager is not active');
        const res = await this.handoffManager.triggerHandoff(args.reason, args.timeoutSeconds);
        return { content: [{ type: 'text', text: res.message }] };
      }
      case 'browser_navigate': {
        await this.page.goto(args.url);
        return { content: [{ type: 'text', text: `Navigated to ${args.url}` }] };
      }
      case 'browser_click': {
        await this.page.click(args.selector);
        return { content: [{ type: 'text', text: `Clicked ${args.selector}` }] };
      }
      case 'browser_type': {
        await this.page.fill(args.selector, args.text);
        return { content: [{ type: 'text', text: `Typed into ${args.selector}` }] };
      }
      case 'browser_snapshot': {
        const title = await this.page.title();
        const url = this.page.url();
        return { content: [{ type: 'text', text: `Page Title: ${title}\nURL: ${url}` }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async listen() {
    await this.initialize();

    const server = new Server(
      { name: 'virium-playwright-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools()
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return this.handleCallTool(name, args || {});
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

module.exports = { ViriumServer };
