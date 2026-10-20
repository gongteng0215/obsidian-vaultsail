// Core logic runs inside a browser in Obsidian. Supply its host for Node-only tests.
globalThis.window ??= globalThis;
globalThis.createSvg = (tag, options) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (options?.cls) element.setAttribute('class', options.cls);
  return element;
};
const { parseHTML } = await import('linkedom');
const { window: dom } = parseHTML('<html></html>');
dom.HTMLElement.prototype.createSpan = function(options) { return this.createEl('span', options); };
dom.SVGElement.prototype.createSvg = function(tag) { return this.appendChild(createSvg(tag)); };
