import { Modal, setIcon, type App } from 'obsidian';
import type { Revision } from '../sync/remote-vault';
import { formatBytes } from '../sync/progress';
import { preserveInteraction } from './interaction';

export interface CloudFolder { kind: 'folder'; name: string; path: string; children: CloudNode[]; files: number; }
export interface CloudFile { kind: 'file'; name: string; path: string; versions: Revision[]; }
export type CloudNode = CloudFolder | CloudFile;
const deleted = (versions: Revision[]) => versions.length > 0 && versions.every(version => version.kind === 'delete');

/** A separate folder map preserves a deleted file even when its path is now a directory. */
export function cloudFileTree(heads: Map<string, Revision[]>, query = '', directories: string[] = [], showDeleted = false): CloudFolder {
  const root: CloudFolder = { kind: 'folder', name: '', path: '', children: [], files: 0 };
  const folders = new Map<string, CloudFolder>([['', root]]);
  const filter = query.trim().toLocaleLowerCase();
  for (const [path, versions] of heads) {
    if (!versions.length || !showDeleted && deleted(versions)) continue;
    if (filter && !path.toLocaleLowerCase().includes(filter)) continue;
    const parts = path.split('/'); let parent = root; parent.files++;
    for (let index = 0; index < parts.length - 1; index++) {
      const folderPath = parts.slice(0, index + 1).join('/'); let folder = folders.get(folderPath);
      if (!folder) { folder = { kind: 'folder', name: parts[index], path: folderPath, children: [], files: 0 }; folders.set(folderPath, folder); parent.children.push(folder); }
      folder.files++; parent = folder;
    }
    parent.children.push({ kind: 'file', name: parts.at(-1)!, path, versions });
  }
  for (const path of directories) {
    if (filter && !path.toLocaleLowerCase().includes(filter)) continue;
    const parts = path.split('/'); let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/'); let folder = folders.get(key);
      if (!folder) { folder = { kind: 'folder', name: parts[i], path: key, children: [], files: 0 }; folders.set(key, folder); parent.children.push(folder); }
      parent = folder;
    }
  }
  for (const folder of folders.values()) folder.children.sort((a, b) => a.kind !== b.kind ? a.kind === 'folder' ? -1 : 1
    : a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) || a.path.localeCompare(b.path));
  return root;
}

/** Native disclosures retain keyboard access; collapsed directories and versions render lazily. */
export class CloudFilesPanel {
  private expanded = new Set<string>();
  private search: HTMLInputElement;
  private list: HTMLElement;
  private summary: HTMLElement;
  private showDeleted: HTMLInputElement;
  constructor(private host: HTMLElement, private heads: Map<string, Revision[]>, private location: string, private directories: string[] = []) {
    host.classList.add('vaultsail-cloud-files');
    const controls = host.createDiv({ cls: 'vs-cloud-controls' });
    this.search = controls.createEl('input'); this.search.type = 'search'; this.search.placeholder = '搜索文件或目录'; this.search.setAttribute('aria-label', '搜索云端文件路径');
    this.search.addEventListener('input', () => this.render());
    const deletedControl = controls.createEl('label', { cls: 'vs-cloud-deleted-toggle' });
    this.showDeleted = deletedControl.createEl('input'); this.showDeleted.type = 'checkbox'; this.showDeleted.checked = false;
    this.showDeleted.setAttribute('aria-label', '显示已删除'); deletedControl.createEl('span', { text: '显示已删除' });
    this.showDeleted.addEventListener('change', () => this.render(true));
    for (const [label, expand] of [['全部展开', true], ['全部折叠', false]] as const) {
      controls.createEl('button', { text: label }).addEventListener('click', () => {
        this.expanded.clear();
        if (expand) for (const path of this.heads.keys()) { const parts = path.split('/'); for (let index = 1; index < parts.length; index++) this.expanded.add(parts.slice(0, index).join('/')); }
        if (expand) for (const path of this.directories) { const parts = path.split('/'); for (let index = 1; index <= parts.length; index++) this.expanded.add(parts.slice(0, index).join('/')); }
        this.render();
      });
    }
    this.summary = host.createEl('p', { cls: 'vs-cloud-summary' }); this.summary.setAttribute('role', 'status');
    this.list = host.createDiv({ cls: 'vs-cloud-tree' }); this.list.setAttribute('aria-label', '云端文件目录');
    const address = host.createEl('details', { cls: 'vs-cloud-location' }); address.createEl('summary', { text: '云端存放位置' }); address.createEl('code', { text: location });
    for (const child of cloudFileTree(heads, '', directories).children) if (child.kind === 'folder') this.expanded.add(child.path);
    this.render();
  }
  private render(restoreDetails = false): void {
    preserveInteraction(this.host, () => this.update(), false, restoreDetails);
  }
  private update(): void {
    const query = this.search.value.trim(), showDeleted = this.showDeleted.checked, tree = cloudFileTree(this.heads, query, this.directories, showDeleted);
    const deletedCount = [...this.heads].filter(([path, versions]) => deleted(versions) && (!query || path.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).length;
    const total = [...this.heads.values()].filter(versions => versions.length && (showDeleted || !deleted(versions))).length;
    const folders = this.directories.filter(path => !query || path.toLocaleLowerCase().includes(query.toLocaleLowerCase())).length;
    this.summary.setText(`${query ? '找到' : '共'} ${tree.files} 个文件路径${query ? ` / ${total}` : ''}${folders ? ` · ${folders} 个已记录目录` : ''}${deletedCount ? showDeleted ? ` · 含 ${deletedCount} 个已删除路径` : ` · 已隐藏 ${deletedCount} 个已删除路径` : ''} · 展开文件查看版本`);
    this.list.empty();
    if (!tree.children.length) this.list.createEl('p', { cls: 'vs-cloud-empty', text: query ? '没有匹配的文件或目录。' + (!showDeleted && deletedCount ? '已删除文件默认隐藏，可开启“显示已删除”查看。' : '')
      : !showDeleted && deletedCount ? '当前没有可显示的文件或目录。已删除文件默认隐藏，可开启“显示已删除”查看历史记录。'
      : '当前云端库还没有笔记或目录版本。创建库不会自动上传笔记，请预览上传后执行。' });
    for (const node of tree.children) this.node(this.list, node, 0, !!query);
  }
  private node(parent: HTMLElement, node: CloudNode, depth: number, searching: boolean): void {
    const row = parent.createEl('details', { cls: node.kind === 'folder' ? 'vs-cloud-folder' : 'vs-cloud-file' });
    row.setAttribute(node.kind === 'folder' ? 'data-cloud-folder' : 'data-cloud-file', node.path);
    const title = row.createEl('summary', { cls: 'vs-cloud-row' });
    const icon = title.createEl('span', { cls: 'vs-cloud-icon' }); icon.setAttribute('aria-hidden', 'true'); setIcon(icon, node.kind === 'folder' ? 'folder' : 'file');
    title.createEl('span', { text: node.name, cls: 'vs-cloud-name' });
    const content = row.createDiv({ cls: 'vs-cloud-children' }); if (depth >= 6) content.classList.add('vs-cloud-deep');
    let rendered = false;
    const populate = () => {
      if (rendered) return; rendered = true;
      if (node.kind === 'folder') { for (const child of node.children) this.node(content, child, depth + 1, searching); }
      else {
        content.createEl('p', { cls: 'vs-cloud-full-path', text: node.path });
        for (const op of node.versions) {
          const version = content.createDiv({ cls: 'vs-cloud-version' });
          version.createEl('p', { text: op.kind === 'update' ? `${formatBytes(op.size)} · 设备 ${op.deviceId.slice(0, 8)} · 版本 ${op.opId.slice(0, 8)}` : '删除版本记录（历史内容保留）' });
          if (op.hash) version.createEl('code', { text: this.location + '/blobs/' + op.hash });
        }
      }
    };
    if (node.kind === 'folder') title.createEl('span', { cls: 'vs-cloud-meta', text: node.children.length ? `${node.files} 个文件` : '空目录' });
    else {
      const updates = node.versions.filter(op => op.kind === 'update');
      const state = deleted(node.versions) ? 'deleted' : node.versions.length > 1 ? 'conflict' : 'current'; row.setAttribute('data-state', state);
      title.createEl('span', { cls: 'vs-cloud-meta', text: state === 'conflict' ? `有冲突 · ${updates.length} 个内容版本` : state === 'deleted' ? '已删除 · 历史保留' : formatBytes(updates[0].size) + ' · 1 个内容版本' });
    }
    row.addEventListener('toggle', () => {
      if (!row.isConnected) return;
      if (row.hasAttribute('open')) populate();
      if (node.kind === 'folder' && !searching) { if (row.hasAttribute('open')) this.expanded.add(node.path); else this.expanded.delete(node.path); }
    });
    if (node.kind === 'folder' && (searching || this.expanded.has(node.path))) { row.setAttribute('open', ''); populate(); }
  }
}

export class CloudFilesModal extends Modal {
  constructor(app: App, private heads: Map<string, Revision[]>, private location: string, private directories: string[] = []) { super(app); }
  onOpen(): void {
    this.titleEl.setText('云端文件与版本'); this.containerEl.classList.add('vaultsail-cloud-modal');
    new CloudFilesPanel(this.contentEl, this.heads, this.location, this.directories);
  }
}
