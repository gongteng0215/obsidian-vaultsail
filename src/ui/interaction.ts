type Field = HTMLInputElement | HTMLTextAreaElement;
const baselines = new WeakMap<Element, string>();
const fields = (root: HTMLElement) => Array.from(root.querySelectorAll<Field>('input:not([type=checkbox]):not([type=radio]),textarea'));
function key(el: Element, root: HTMLElement): string {
  if (el === root) return '$root';
  if (el.id) return '#' + el.id;
  const row = el.closest('.setting-item');
  const label = el.getAttribute('aria-label') ?? (el.tagName === 'BUTTON' || el.tagName === 'SUMMARY' ? el.textContent : null);
  const scope = el.closest('[data-file-id],[data-history-id],[data-cloud-folder],[data-cloud-file]');
  const marker = label ? 0 : el.getAttribute('class') || Array.from((row ?? scope ?? root).querySelectorAll(el.tagName)).indexOf(el);
  return JSON.stringify([row?.querySelector('.setting-item-name')?.textContent, scope?.getAttribute('data-file-id') ?? scope?.getAttribute('data-history-id') ?? scope?.getAttribute('data-cloud-folder') ?? scope?.getAttribute('data-cloud-file'), el.tagName, label,
    marker, el.getAttribute('type')]);
}
export function rememberFields(root: HTMLElement): void { for (const field of fields(root)) baselines.set(field, field.value); }
export function acceptFields(root: HTMLElement): () => void {
  const before = fields(root).map(field => ({ field, value: baselines.get(field) })); rememberFields(root);
  return () => { for (const { field, value } of before) { if (value === undefined) baselines.delete(field); else baselines.set(field, value); } };
}

/** Capture at DOM commit time, never before an await. Restore synchronously so a
 * delayed callback cannot undo the user's next scroll, focus or selection. */
export function preserveInteraction(root: HTMLElement, render: () => void, preserveDrafts = false, restoreDetails = true): void {
  const active = root.ownerDocument.activeElement;
  const focused = active && root.contains(active) ? active as HTMLElement : undefined;
  const focusKey = focused && key(focused, root);
  const selection = focused && 'selectionStart' in focused ? {
    start: (focused as Field).selectionStart, end: (focused as Field).selectionEnd, direction: (focused as Field).selectionDirection,
  } : undefined;
  const scroll: { el: HTMLElement; key?: string; top: number; left: number }[] = [];
  for (let el: HTMLElement | null = root; el; el = el.parentElement) scroll.push({ el, top: el.scrollTop, left: el.scrollLeft });
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) if (el.scrollTop || el.scrollLeft) scroll.push({ el, key: key(el, root), top: el.scrollTop, left: el.scrollLeft });
  const open = new Map(Array.from(root.querySelectorAll('details')).map(el => [key(el.querySelector('summary') ?? el, root), el.hasAttribute('open')]));
  const drafts = preserveDrafts ? fields(root).filter(field => baselines.has(field) && baselines.get(field) !== field.value).map(field => ({ key: key(field, root), value: field.value })) : [];
  render();
  const byKey = new Map(Array.from(root.querySelectorAll<HTMLElement>('*')).map(el => [key(el, root), el])); byKey.set('$root', root);
  if (restoreDetails) for (const el of Array.from(root.querySelectorAll('details'))) { const state = open.get(key(el.querySelector('summary') ?? el, root)); if (state !== undefined) el.toggleAttribute('open', state); }
  for (const draft of drafts) {
    const field = byKey.get(draft.key) as Field | undefined;
    if (!field || field.value === draft.value) continue;
    field.value = draft.value;
    field.dispatchEvent(new (root.ownerDocument.defaultView!.Event)('input', { bubbles: true }));
  }
  const target = focusKey && byKey.get(focusKey);
  if (target && !target.hasAttribute('disabled') && root.ownerDocument.activeElement !== target) target.focus({ preventScroll: true });
  if (target && selection?.start !== null && selection?.start !== undefined && typeof (target as Field).setSelectionRange === 'function') {
    try { (target as Field).setSelectionRange(selection.start, selection.end, selection.direction ?? undefined); } catch { /* Number inputs have no text selection API. */ }
  }
  for (const saved of scroll) {
    const el = saved.key ? byKey.get(saved.key) : saved.el;
    if (el) { el.scrollTop = saved.top; el.scrollLeft = saved.left; }
  }
}
