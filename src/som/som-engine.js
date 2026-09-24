class SomEngine {
  constructor() {
    this.cachedMarks = new Map();
  }

  async annotate(page, filter = 'clickable') {
    // 1. Inject DOM overlay script
    const marks = await page.evaluate((filterMode) => {
      const old = document.getElementById('__virium_som_overlay__');
      if (old) old.remove();

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = '__virium_som_overlay__';
      svg.style.position = 'fixed';
      svg.style.top = '0';
      svg.style.left = '0';
      svg.style.width = '100vw';
      svg.style.height = '100vh';
      svg.style.pointerEvents = 'none';
      svg.style.zIndex = '2147483647';

      const interactableSelectors = [
        'button', 'a[href]', 'input', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="checkbox"]',
        '[role="menuitem"]', '[role="tab"]', '[onclick]'
      ].join(',');

      const candidates = Array.from(document.querySelectorAll(interactableSelectors));
      document.querySelectorAll('*').forEach(el => {
        if (!candidates.includes(el)) {
          const style = window.getComputedStyle(el);
          if (style.cursor === 'pointer' && el.children.length === 0) {
            candidates.push(el);
          }
        }
      });

      const markList = [];
      let markId = 1;

      candidates.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 4 || rect.height <= 4) return;
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        if (rect.right < 0 || rect.left > window.innerWidth) return;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hitEl = document.elementFromPoint(centerX, centerY);
        if (hitEl && !el.contains(hitEl) && !hitEl.contains(el)) return;

        // Draw bounding box
        const rectElem = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rectElem.setAttribute('x', rect.left);
        rectElem.setAttribute('y', rect.top);
        rectElem.setAttribute('width', rect.width);
        rectElem.setAttribute('height', rect.height);
        rectElem.setAttribute('fill', 'rgba(255, 0, 85, 0.08)');
        rectElem.setAttribute('stroke', '#FF0055');
        rectElem.setAttribute('stroke-width', '2');
        rectElem.setAttribute('rx', '2');
        svg.appendChild(rectElem);

        // Draw Badge Background
        const badgeW = 22;
        const badgeH = 16;
        const badgeBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        badgeBg.setAttribute('x', Math.max(0, rect.left));
        badgeBg.setAttribute('y', Math.max(0, rect.top - badgeH));
        badgeBg.setAttribute('width', badgeW);
        badgeBg.setAttribute('height', badgeH);
        badgeBg.setAttribute('fill', '#FF0055');
        badgeBg.setAttribute('rx', '2');
        svg.appendChild(badgeBg);

        // Draw Badge Text
        const textElem = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        textElem.setAttribute('x', Math.max(0, rect.left) + badgeW / 2);
        textElem.setAttribute('y', Math.max(0, rect.top - badgeH) + 12);
        textElem.setAttribute('fill', '#FFFFFF');
        textElem.setAttribute('font-size', '11px');
        textElem.setAttribute('font-weight', 'bold');
        textElem.setAttribute('text-anchor', 'middle');
        textElem.setAttribute('font-family', 'sans-serif');
        textElem.textContent = markId.toString();
        svg.appendChild(textElem);

        el.setAttribute('data-virium-mark-id', markId.toString());

        markList.push({
          markId: markId,
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 50),
          bbox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        });

        markId++;
      });

      document.body.appendChild(svg);
      return markList;
    }, filter);

    // 2. Cache marks
    this.cachedMarks.clear();
    marks.forEach(m => this.cachedMarks.set(m.markId, m));

    // 3. Take screenshot
    const buffer = await page.screenshot({ type: 'png', fullPage: false });

    // 4. Remove SVG overlay
    await page.evaluate(() => {
      const overlay = document.getElementById('__virium_som_overlay__');
      if (overlay) overlay.remove();
    });

    return {
      imageBase64: buffer.toString('base64'),
      marks
    };
  }

  async interactWithMark(page, markId, action, text) {
    const mark = this.cachedMarks.get(markId);
    if (!mark) throw new Error(`Mark ID ${markId} not found in current snapshot`);

    const locator = page.locator(`[data-virium-mark-id="${markId}"]`);
    await locator.waitFor({ state: 'attached', timeout: 3000 });

    switch (action) {
      case 'click':
        await locator.click();
        break;
      case 'double_click':
        await locator.dblclick();
        break;
      case 'hover':
        await locator.hover();
        break;
      case 'type':
        if (text === undefined) throw new Error('Text parameter required for type action');
        await locator.fill(text);
        break;
      default:
        throw new Error(`Unsupported action: ${action}`);
    }
  }
}

module.exports = { SomEngine };
