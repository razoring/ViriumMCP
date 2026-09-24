class HandoffManager {
  constructor(qemuController) {
    this.qemuController = qemuController;
    this.inHandoff = false;
  }

  async triggerHandoff(reason, timeoutSeconds = 300) {
    if (this.inHandoff) throw new Error('Handoff already in progress');

    this.inHandoff = true;
    try {
      // 1. Switch QEMU display to headful (pops up native SDL/GTK window on host)
      await this.qemuController.switchDisplayToHeadful('user_handoff');

      // 2. Wait for user signal or timeout
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve();
        }, timeoutSeconds * 1000);

        // Allow manual console resolution if stdio is attached
        if (process.stdin.isTTY) {
          console.log(`\n==================================================`);
          console.log(`[Virium Handoff] User intervention required: ${reason}`);
          console.log(`Press ENTER in terminal when finished to hand control back to agent...`);
          console.log(`==================================================\n`);

          const onData = () => {
            process.stdin.removeListener('data', onData);
            clearTimeout(timer);
            resolve();
          };
          process.stdin.once('data', onData);
        }
      });

      // 3. Restore QEMU to headless mode
      await this.qemuController.switchDisplayToHeadless('user_handoff_complete');
      return { success: true, message: 'User handed control back to agent.' };
    } finally {
      this.inHandoff = false;
    }
  }
}

module.exports = { HandoffManager };
