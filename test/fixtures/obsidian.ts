// Runtime harness for integration tests only. The production bundle externalizes obsidian.
const element = (parent: HTMLElement, tag: string) => parent.appendChild(document.createElement(tag));
export class App {}
export class TFile { path: string; stat: { size: number }; constructor(path: string, size: number) { this.path = path; this.stat = { size }; } }
export class Notice { static messages: string[] = []; constructor(message: string) { Notice.messages.push(message); } }
export function requireApiVersion(): boolean { return true; }
export async function requestUrl(input: unknown): Promise<unknown> { return (globalThis as unknown as { mockRequest: (input: unknown) => Promise<unknown> }).mockRequest(input); }
export class Plugin {
  app: any; manifest = { version: '0.1.14' }; commands: any[] = []; tabs: any[] = []; saved: unknown;
  constructor(app: unknown) { this.app = app; }
  async loadData(): Promise<unknown> { return this.saved; }
  async saveData(value: unknown): Promise<void> { this.saved = structuredClone(value); }
  addSettingTab(tab: unknown): void { this.tabs.push(tab); }
  addCommand(command: unknown): void { this.commands.push(command); }
  addRibbonIcon(): void {} registerEvent(): void {} registerDomEvent(): void {}
}
export class PluginSettingTab {
  app: any; containerEl: HTMLElement;
  constructor(app: unknown) { this.app = app; this.containerEl = element(document.body, 'section'); }
}
export class Modal {
  app: any; containerEl: HTMLElement; titleEl: HTMLElement; contentEl: HTMLElement;
  constructor(app: unknown) { this.app = app; this.containerEl = document.createElement('section'); this.titleEl = element(this.containerEl, 'h2'); this.contentEl = element(this.containerEl, 'div'); }
  open(): void { document.body.appendChild(this.containerEl); (this as unknown as { onOpen?: () => void }).onOpen?.(); }
  close(): void { (this as unknown as { onClose?: () => void }).onClose?.(); this.containerEl.remove(); }
}
class Component {
  inputEl: HTMLInputElement; private eventName: string;
  constructor(parent: HTMLElement, tag = 'input', eventName = 'change') { this.inputEl = element(parent, tag) as HTMLInputElement; this.eventName = eventName; }
  setValue(value: string | boolean): this {
    if (typeof value === 'boolean') this.inputEl.checked = value;
    else if (this.inputEl.tagName === 'SELECT') { for (const option of this.inputEl.querySelectorAll('option')) (option as HTMLOptionElement).selected = option.value === value; }
    else this.inputEl.value = value;
    return this;
  }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  setDisabled(value: boolean): this { this.inputEl.disabled = value; return this; }
  setButtonText(value: string): this { this.inputEl.textContent = value; return this; }
  setCta(): this { return this; }
  addOption(value: string, text: string): this { const option = element(this.inputEl, 'option') as HTMLOptionElement; option.value = value; option.textContent = text; return this; }
  addOptions(value: Record<string, string>): this { for (const [key, label] of Object.entries(value)) this.addOption(key, label); return this; }
  onChange(callback: (value: any) => unknown): this { this.inputEl.addEventListener(this.eventName, () => { void callback(this.inputEl.type === 'checkbox' ? this.inputEl.checked : this.inputEl.value); }); return this; }
  onClick(callback: () => unknown): this { this.inputEl.addEventListener('click', () => { void callback(); }); return this; }
}
export class SecretComponent extends Component { constructor(_app: unknown, parent: HTMLElement) { super(parent); this.inputEl.setAttribute('data-secret-reference', 'true'); } }
export class Setting {
  private el: HTMLElement;
  constructor(parent: HTMLElement) { this.el = element(parent, 'div'); this.el.className = 'setting-item'; }
  setName(value: string): this { element(this.el, 'label').textContent = value; return this; }
  setHeading(): this { this.el.classList.add('setting-item-heading'); return this; }
  setClass(value: string): this { this.el.classList.add(value); return this; }
  setDesc(value: string): this { element(this.el, 'p').textContent = value; return this; }
  addText(callback: (input: Component) => unknown): this { callback(new Component(this.el, 'input', 'input')); return this; }
  addDropdown(callback: (input: Component) => unknown): this { callback(new Component(this.el, 'select')); return this; }
  addButton(callback: (input: Component) => unknown): this { callback(new Component(this.el, 'button')); return this; }
  addToggle(callback: (input: Component) => unknown): this { const input = new Component(this.el); input.inputEl.type = 'checkbox'; callback(input); return this; }
  addComponent(callback: (el: HTMLElement) => unknown): this { callback(this.el); return this; }
}
