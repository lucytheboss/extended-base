/**
 * The `notion-table` Bases view: renders query results as a Notion-style table
 * with hover OPEN buttons, colored pills, inline editing, and a select editor
 * for pill cells. Re-renders from scratch on every `onDataUpdated`.
 */
import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	BooleanValue,
	FileValue,
	LinkValue,
	Notice,
	NumberValue,
	Platform,
	QueryController,
	TFile,
	Menu,
	MarkdownRenderer,
	getIconIds,
	setIcon,
} from 'obsidian';
import { LOG_PREFIX, NOTION_TABLE_VIEW } from '../constants';
import { PinnedColors, applyPillColor, colorByName } from '../lib/colors';
import { PillDetection, computePillProps, parsePinnedColors, stripPath } from '../lib/pills';
import { buildGroupTree, countEntries, GroupNode } from '../lib/groups';
import { getPropertyIcon, getPropertyMetaType } from '../lib/property-types';
import { valueToStrings } from '../lib/values';
import { NotePageModal, OpenSelectOpts } from './note-modal';
import { SelectEditor } from './select-editor';

/**
 * Internal shape of the core toolbar's new-item menu (`QueryController.
 * newItemMenu` — not in the public API). Guarded at runtime before use.
 */
interface CoreNewItemMenu {
	open(name?: string, frontmatterProcessor?: (fm: Record<string, unknown>) => void): Promise<void>;
	close(): void;
}

export class NotionTableView extends BasesView {
	readonly type = NOTION_TABLE_VIEW;
	private rootEl: HTMLElement;
	/** The controller this view was created for (holds the core toolbar). */
	private readonly queryCtrl: QueryController;
	/** True while the toolbar's New button is rerouted to the page panel. */
	private newButtonPatched = false;
	/** Pill / list classification, recomputed each update. */
	private pills: PillDetection = { pillProps: new Set(), listProps: new Set() };
	/** User-pinned value → color overrides from the `pinnedColors` view option. */
	private pinnedColors: PinnedColors = new Map();
	/** Set of group full keys that are currently collapsed. */
	private collapsedGroups = new Set<string>();
	/** The open select editor, if any (also drives outside-click detection). */
	private selectEditor: SelectEditor | null = null;

	constructor(controller: QueryController, parentEl: HTMLElement) {
		super(controller);
		this.queryCtrl = controller;
		this.rootEl = parentEl.createDiv({ cls: 'ntn-root' });
		this.register(() => this.closeSelectMenu());
		// rootEl.doc resolves to the view's own document, so this also works
		// when the view lives in a popout window (plain `document` would not).
		// One persistent capture-phase listener that no-ops unless a menu is open
		// — do not revert to a per-menu `document.addEventListener`.
		this.registerDomEvent(this.rootEl.doc, 'pointerdown', (evt) => {
			if (!this.selectEditor) return;
			const target = evt.target as Node;
			if (this.selectEditor.contains(target)) return;
			// A click on the anchoring cell is left to that cell's own click
			// handler, which toggles the menu shut (see openSelectEditor).
			// Closing here too would let the click re-open it instead.
			if (this.selectEditor.anchorEl.contains(target)) return;
			this.closeSelectMenu();
		}, { capture: true });
		this.patchToolbarNew();
	}


	onDataUpdated(): void {
		// The toolbar may not have existed at construction time; retry until
		// the patch lands (no-op once it has).
		this.patchToolbarNew();
		const root = this.rootEl;
		root.empty();

		// Default-on: only an explicit `false` turns wrapping off (mirrors verticalLines).
		root.toggleClass('ntn-wrap', this.config.get('wrapCells') !== false);
		root.toggleClass('ntn-vlines', this.config.get('verticalLines') !== false);

		const props = this.applyColumnOrder(this.config.getOrder());
		this.pills = computePillProps(props, this.data.data, this.config, this.app);
		this.pinnedColors = parsePinnedColors(this.config.get('pinnedColors'));
		const sortState = this.getSortState();

		const table = root.createEl('table', { cls: 'ntn-table' });

		// ---- Header ----
		const thead = table.createEl('thead');
		const headRow = thead.createEl('tr');
		const customNames = this.config.get('columnNames') as Record<string, string> || {};
		const wrapColumns = this.config.get('wrapColumns') as string[] || [];

		// Dummy column to preserve Bases core drag-and-drop index offset (ignores first column)
		headRow.createEl('th', { cls: 'ntn-th ntn-col-title ntn-col-dummy' });

		const columnIcons = this.config.get('columnIcons') as Record<string, string> || {};

		for (const prop of props) {
			const th = headRow.createEl('th', { cls: 'ntn-th', attr: { 'data-ntn-prop': prop } });

			// Icon + title live in one flex wrapper so they line up on a shared
			// baseline (this is also the click-to-sort / press-and-drag-to-reorder
			// target — the resizer handle sits outside it).
			const titleWrap = th.createDiv({ cls: 'ntn-th-title' });

			const icon = columnIcons[prop] || getPropertyIcon(this.app, prop);
			const iconSpan = titleWrap.createSpan({ cls: 'ntn-th-icon' });
			setIcon(iconSpan, icon);

			const titleText = customNames[prop] || this.config.getDisplayName(prop);
			const titleSpan = titleWrap.createSpan({ text: titleText, cls: 'ntn-th-title-text' });

			if (sortState?.prop === prop) {
				const sortIcon = titleWrap.createSpan({ cls: 'ntn-th-sort-icon' });
				setIcon(sortIcon, sortState.direction === 'asc' ? 'arrow-up' : 'arrow-down');
			}

			// Double-click (or the context menu below) to rename.
			titleSpan.addEventListener('dblclick', (e) => {
				e.stopPropagation();
				this.startRename(titleSpan, prop, titleText);
			});

			// Click to sort by this column; press-and-drag to reorder columns.
			this.setupHeaderInteraction(th, titleWrap, prop, props);

			// Context menu: icon, rename, wrap, colors.
			th.addEventListener('contextmenu', (e) => {
				e.preventDefault();
				const menu = new Menu();

				menu.addItem((item) => {
					item.setTitle('Change icon')
						.setIcon('smile')
						.onClick(() => this.openIconPicker(iconSpan, prop));
				});
				menu.addItem((item) => {
					item.setTitle('Change property name')
						.setIcon('pencil')
						.onClick(() => this.startRename(titleSpan, prop, titleText));
				});

				menu.addSeparator();

				const isWrapped = wrapColumns.includes(prop);
				menu.addItem((item) => {
					item.setTitle(isWrapped ? 'Disable Wrap' : 'Enable Wrap')
						.setIcon('lines-of-text')
						.onClick(() => {
							const newWrap = isWrapped ? wrapColumns.filter(c => c !== prop) : [...wrapColumns, prop];
							this.config.set('wrapColumns', newWrap);
						});
				});

				if (this.pills.pillProps.has(prop)) {
					const disableColorColumns = this.config.get('disableColorColumns') as string[] || [];
					const isColorDisabled = disableColorColumns.includes(prop);
					menu.addItem((item) => {
						item.setTitle(isColorDisabled ? 'Enable Default Colors' : 'Disable Default Colors')
							.setIcon('palette')
							.onClick(() => {
								const newDisable = isColorDisabled ? disableColorColumns.filter(c => c !== prop) : [...disableColorColumns, prop];
								this.config.set('disableColorColumns', newDisable);
							});
					});
				}

				menu.showAtMouseEvent(e);
			});

			this.applyColumnWidth(th, prop);
		}

		// ---- Body (group-aware) ----
		const tbody = table.createEl('tbody');
		const colCount = props.length + 1;

		let renderedCount = 0;
		let limitRaw = this.config.get('rowLimit');
		if (limitRaw === undefined) limitRaw = 50;
		const limit = limitRaw === 'all' ? 'all' : parseInt(String(limitRaw), 10) || 50;

		const roots = buildGroupTree(this.data.groupedData);
		if (sortState) {
			for (const rootNode of roots.values()) this.applySortToTree(rootNode, sortState);
		}

		const renderNode = (node: GroupNode, depth: number) => {
			if (limit !== 'all' && renderedCount >= limit) return;

			let isCollapsed = false;
			if (node.key) {
				isCollapsed = this.collapsedGroups.has(node.fullKey);
				
				const gRow = tbody.createEl('tr', { cls: 'ntn-group-row' });
				const gCell = gRow.createEl('td', { attr: { colspan: String(colCount) } });
				
				// Indent by depth; the stylesheet reads this as padding-left.
				gCell.setCssProps({ '--ntn-indent': `${(depth * 20) + 10}px` });
				
				const toggleIcon = gCell.createSpan({ cls: 'ntn-group-toggle' });
				toggleIcon.setText(isCollapsed ? '▶' : '▼');
				toggleIcon.addEventListener('click', () => {
					if (isCollapsed) {
						this.collapsedGroups.delete(node.fullKey);
					} else {
						this.collapsedGroups.add(node.fullKey);
					}
					this.onDataUpdated();
				});

				const pill = gCell.createSpan({ cls: 'ntn-pill' });
				this.applyPillColor(pill, node.fullKey);
				pill.setText(node.key);
				gCell.createSpan({ cls: 'ntn-group-count', text: String(countEntries(node)) });
			}

			if (isCollapsed) return;

			// Render entries at this level
			for (const entry of node.entries) {
				if (limit !== 'all' && renderedCount >= limit) break;
				const tr = this.renderRow(tbody, entry, props);
				if (node.key) {
					// The first cell that is not the hidden dummy gets indented.
					const firstVisibleCell = Array.from(tr.cells).find(
						(c) => !c.hasClass('ntn-col-dummy'),
					);
					firstVisibleCell?.setCssProps({ '--ntn-indent': `${(depth * 20) + 30}px` });
				}
				renderedCount++;
			}

			for (const child of node.children.values()) {
				renderNode(child, node.key ? depth + 1 : depth);
			}
		};

		for (const rootNode of roots.values()) {
			renderNode(rootNode, 0);
		}

		// ---- "+ New" footer and Row limit ----
		const footerWrap = root.createDiv({ cls: 'ntn-footer-wrap' });
		
		const newRow = footerWrap.createDiv({ cls: 'ntn-new-row' });
		newRow.createSpan({ cls: 'ntn-new-plus', text: '+' });
		newRow.createSpan({ text: 'New' });
		newRow.addEventListener('click', () => void this.createAndOpenPage());

		const limitSelect = footerWrap.createDiv({ cls: 'ntn-limit-subtle', text: `Rows: ${limit} ▾` });
		limitSelect.addEventListener('click', (e) => {
			const menu = new Menu();
			const limits: (number | 'all')[] = [10, 20, 50, 'all'];
			limits.forEach(val => {
				menu.addItem((item) => {
					item.setTitle(val === 'all' ? 'All' : String(val))
						.setChecked(String(val) === String(limit))
						.onClick(() => {
							this.config.set('rowLimit', val);
						});
				});
			});
			menu.showAtMouseEvent(e);
		});
	}

	private applyColumnWidth(th: HTMLElement, propId: string) {
		const widths = this.config.get('columnWidths') as Record<string, number> || {};
		// Width lives in a CSS variable the stylesheet reads, so the element
		// carries no inline width/min-width of its own.
		const setWidth = (px: number) => th.setCssProps({ '--ntn-col-width': `${px}px` });
		let width = widths[propId] ?? 0;
		if (width) setWidth(width);

		const resizer = th.createDiv({ cls: 'ntn-resizer' });
		let startX = 0;
		let startW = 0;
		let isResizing = false;

		const moveHandler = (ev: PointerEvent) => {
			if (!isResizing) return;
			const dx = ev.clientX - startX;
			width = Math.max(20, startW + dx);
			setWidth(width);
		};

		const upHandler = () => {
			if (!isResizing) return;
			isResizing = false;
			resizer.removeClass('is-resizing');
			document.removeEventListener('pointermove', moveHandler);
			document.removeEventListener('pointerup', upHandler);
			const cur = this.config.get('columnWidths') as Record<string, number> || {};
			this.config.set('columnWidths', { ...cur, [propId]: width });
		};

		resizer.addEventListener('pointerdown', (e) => {
			e.preventDefault();
			e.stopPropagation();
			isResizing = true;
			startX = e.clientX;
			startW = th.getBoundingClientRect().width;
			resizer.addClass('is-resizing');
			document.addEventListener('pointermove', moveHandler);
			document.addEventListener('pointerup', upHandler);
		});
	}

	/** Apply the user's saved column order on top of Bases' own property order. */
	private applyColumnOrder(props: BasesPropertyId[]): BasesPropertyId[] {
		const stored = this.config.get('columnOrder') as string[] | undefined;
		if (!Array.isArray(stored) || !stored.length) return props;
		const propSet = new Set(props);
		const ordered = stored.filter((p) => propSet.has(p as BasesPropertyId)) as BasesPropertyId[];
		const seen = new Set(ordered);
		for (const p of props) if (!seen.has(p)) ordered.push(p);
		return ordered;
	}

	/** Move `fromProp` next to `toProp` (before/after) and persist the new order. */
	private reorderColumn(props: BasesPropertyId[], fromProp: BasesPropertyId, toProp: BasesPropertyId, after: boolean): void {
		const without = props.filter((p) => p !== fromProp);
		let toIndex = without.indexOf(toProp);
		if (toIndex === -1) return;
		if (after) toIndex += 1;
		without.splice(toIndex, 0, fromProp);
		this.config.set('columnOrder', without);
	}

	/** The current header-click sort, if any. */
	private getSortState(): { prop: BasesPropertyId; direction: 'asc' | 'desc' } | null {
		const raw = this.config.get('ntnSort') as { prop?: string; direction?: string } | null | undefined;
		if (!raw || !raw.prop) return null;
		return { prop: raw.prop as BasesPropertyId, direction: raw.direction === 'desc' ? 'desc' : 'asc' };
	}

	/** Cycle a column's sort: none -> ascending -> descending -> none. Single-column, like Notion. */
	private toggleSort(prop: BasesPropertyId): void {
		const current = this.getSortState();
		let next: { prop: BasesPropertyId; direction: 'asc' | 'desc' } | null;
		if (!current || current.prop !== prop) {
			next = { prop, direction: 'asc' };
		} else if (current.direction === 'asc') {
			next = { prop, direction: 'desc' };
		} else {
			next = null;
		}
		this.config.set('ntnSort', next);
	}

	/**
	 * A plain click sorts; a click that turns into a drag reorders. Both
	 * gestures start the same way, so tell them apart by movement past a
	 * small threshold, then commit to one interpretation for the gesture.
	 * The second click of a double-click (renaming) is swallowed by the
	 * pending-timer dance in {@link scheduleSortToggle} so it never sorts.
	 */
	private setupHeaderInteraction(
		th: HTMLElement,
		titleWrap: HTMLElement,
		prop: BasesPropertyId,
		props: BasesPropertyId[],
	): void {
		const THRESHOLD = 6;
		const doc = th.doc;

		titleWrap.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0) return;
			// Let a click inside the active rename input place the caret instead
			// of scheduling a sort toggle or starting a column drag.
			if ((e.target as HTMLElement).closest('.ntn-rename-input')) return;
			const startX = e.clientX;
			const startY = e.clientY;
			let dragging = false;
			let dropTarget: HTMLElement | null = null;
			let insertAfter = false;

			const clearIndicator = () => {
				dropTarget?.removeClass('ntn-col-drop-before');
				dropTarget?.removeClass('ntn-col-drop-after');
				dropTarget = null;
			};

			const onMove = (ev: PointerEvent) => {
				if (!dragging) {
					if (Math.abs(ev.clientX - startX) < THRESHOLD && Math.abs(ev.clientY - startY) < THRESHOLD) return;
					dragging = true;
					th.addClass('ntn-th-dragging');
				}
				const el = doc.elementFromPoint(ev.clientX, ev.clientY);
				const targetTh = el?.closest('th.ntn-th') as HTMLElement | null;
				clearIndicator();
				if (targetTh && targetTh !== th && !targetTh.hasClass('ntn-col-dummy')) {
					const rect = targetTh.getBoundingClientRect();
					insertAfter = ev.clientX > rect.left + rect.width / 2;
					targetTh.addClass(insertAfter ? 'ntn-col-drop-after' : 'ntn-col-drop-before');
					dropTarget = targetTh;
				}
			};

			const onUp = () => {
				doc.removeEventListener('pointermove', onMove);
				doc.removeEventListener('pointerup', onUp);
				th.removeClass('ntn-th-dragging');
				const targetProp = dropTarget?.getAttr('data-ntn-prop') as BasesPropertyId | null;
				clearIndicator();
				if (dragging && targetProp && targetProp !== prop) {
					this.reorderColumn(props, prop, targetProp, insertAfter);
				} else if (!dragging) {
					this.scheduleSortToggle(prop);
				}
			};

			doc.addEventListener('pointermove', onMove);
			doc.addEventListener('pointerup', onUp);
		});
	}

	/** Pending single-click sort toggle; a second click within the window cancels it (see {@link setupHeaderInteraction}). */
	private sortClickTimer: number | null = null;

	private scheduleSortToggle(prop: BasesPropertyId): void {
		if (this.sortClickTimer !== null) {
			window.clearTimeout(this.sortClickTimer);
			this.sortClickTimer = null;
			return;
		}
		this.sortClickTimer = window.setTimeout(() => {
			this.sortClickTimer = null;
			this.toggleSort(prop);
		}, 250);
	}

	/** Sort every group's entries by `sortState`, recursing into nested groups. */
	private applySortToTree(
		node: GroupNode,
		sortState: { prop: BasesPropertyId; direction: 'asc' | 'desc' },
	): void {
		const dir = sortState.direction === 'asc' ? 1 : -1;
		node.entries.sort((a, b) => dir * this.compareEntries(a, b, sortState.prop));
		for (const child of node.children.values()) this.applySortToTree(child, sortState);
	}

	/**
	 * Compare two entries by one property. Pill/select columns with a
	 * user-defined option order (see the select editor's drag handles)
	 * sort by that order instead of alphabetically; numbers and booleans
	 * compare numerically; everything else falls back to a locale/numeric
	 * string compare (which also sorts ISO dates correctly).
	 */
	private compareEntries(a: BasesEntry, b: BasesEntry, prop: BasesPropertyId): number {
		const va = a.getValue(prop);
		const vb = b.getValue(prop);
		if (va == null && vb == null) return 0;
		if (va == null) return -1;
		if (vb == null) return 1;

		if (this.pills.pillProps.has(prop)) {
			const order = this.getSelectOrder(prop);
			if (order) {
				const sa = (valueToStrings(va)[0] ?? '').toLowerCase();
				const sb = (valueToStrings(vb)[0] ?? '').toLowerCase();
				const ia = order.indexOf(sa);
				const ib = order.indexOf(sb);
				if (ia === -1 && ib === -1) return sa.localeCompare(sb);
				if (ia === -1) return 1;
				if (ib === -1) return -1;
				return ia - ib;
			}
		}

		if (va instanceof NumberValue && vb instanceof NumberValue) {
			return Number(va.toString()) - Number(vb.toString());
		}
		if (va instanceof BooleanValue && vb instanceof BooleanValue) {
			return Number(va.isTruthy()) - Number(vb.isTruthy());
		}
		return va.toString().localeCompare(vb.toString(), undefined, { sensitivity: 'base', numeric: true });
	}

	/** The user's saved option order for a select/pill property, or null if none is set. */
	private getSelectOrder(prop: BasesPropertyId): string[] | null {
		const bare = prop.split('.').slice(1).join('.');
		const order = this.getSelectOptionOrder(bare);
		return order.length ? order : null;
	}

	/** Swap a header title for an inline rename input; Enter/blur commits, Esc cancels. */
	private startRename(titleSpan: HTMLElement, prop: BasesPropertyId, titleText: string): void {
		if (titleSpan.querySelector('.ntn-rename-input')) return;
		titleSpan.empty();
		const input = titleSpan.createEl('input', { type: 'text', value: titleText, cls: 'ntn-rename-input' });
		input.focus();
		input.select();
		const save = () => {
			const newName = input.value.trim();
			const current = this.config.get('columnNames') as Record<string, string> || {};
			if (newName && newName !== this.config.getDisplayName(prop)) {
				this.config.set('columnNames', { ...current, [prop]: newName });
			} else {
				const next = { ...current };
				delete next[prop];
				this.config.set('columnNames', next);
			}
		};
		input.addEventListener('blur', save);
		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') save();
			if (ke.key === 'Escape') this.config.set('columnNames', this.config.get('columnNames')); // Force re-render
		});
	}

	/** A searchable Lucide icon grid, floated just below `anchor` (the column's icon glyph). */
	private openIconPicker(anchor: HTMLElement, prop: BasesPropertyId): void {
		const doc = anchor.doc;
		doc.querySelector('.ntn-icon-menu')?.remove();

		const menu = doc.body.createDiv({ cls: 'ntn-root ntn-icon-menu' });
		const searchEl = menu.createEl('input', {
			type: 'text',
			cls: 'ntn-select-input ntn-icon-search',
			attr: { placeholder: 'Search icons…', spellcheck: 'false' },
		});
		const gridEl = menu.createDiv({ cls: 'ntn-icon-grid' });

		const allIcons = getIconIds();
		const renderGrid = (query: string) => {
			gridEl.empty();
			const q = query.trim().toLowerCase();
			const matches = (q ? allIcons.filter((id) => id.includes(q)) : allIcons).slice(0, 200);
			for (const iconId of matches) {
				const btn = gridEl.createDiv({ cls: 'ntn-icon-option', attr: { 'aria-label': iconId } });
				setIcon(btn, iconId);
				btn.addEventListener('click', () => {
					const current = this.config.get('columnIcons') as Record<string, string> || {};
					this.config.set('columnIcons', { ...current, [prop]: iconId });
					close();
				});
			}
		};
		renderGrid('');
		searchEl.addEventListener('input', () => renderGrid(searchEl.value));
		searchEl.focus();

		const rect = anchor.getBoundingClientRect();
		const win = anchor.win;
		const menuWidth = 260;
		const left = Math.min(rect.left, win.innerWidth - menuWidth - 8);
		menu.setCssStyles({ left: `${Math.max(8, left)}px`, top: `${rect.bottom + 4}px` });

		const onOutside = (e: PointerEvent) => {
			if (!menu.contains(e.target as Node)) close();
		};
		const close = () => {
			menu.remove();
			doc.removeEventListener('pointerdown', onOutside, true);
		};
		doc.addEventListener('pointerdown', onOutside, true);
		this.register(close);
	}

	private renderRow(
		tbody: HTMLElement,
		entry: BasesEntry,
		props: BasesPropertyId[],
	): HTMLTableRowElement {
		const tr = tbody.createEl('tr', { cls: 'ntn-row' });

		// Dummy cell for the hidden dummy column
		tr.createEl('td', { cls: 'ntn-td ntn-col-title ntn-col-dummy' });

		const widths = this.config.get('columnWidths') as Record<string, number> || {};
		for (const prop of props) {
			const td = tr.createEl('td', { cls: 'ntn-td' });
			// Mirror the header's resized width onto the cell: the stylesheet's
			// default max-width (280px) only applies while this is unset, so a
			// resized column — the title/file-name one included — isn't capped
			// back down to 280px regardless of how far the header was dragged.
			const width = widths[prop];
			if (width) td.setCssProps({ '--ntn-col-width': `${width}px` });
			if ((this.config.get('wrapColumns') as string[] || [])?.includes(prop)) {
				td.addClass('ntn-wrap-cell');
			}
			this.renderCell(td, entry, prop);
		}
		return tr;
	}

	private renderCell(td: HTMLElement, entry: BasesEntry, prop: BasesPropertyId): void {
		if (prop === 'file.name') {
			td.addClass('ntn-col-title'); // Inherit some styling like min-width
			
			const titleWrap = td.createDiv({ cls: 'ntn-title-wrap' });

			const link = titleWrap.createSpan({ text: entry.file.basename, cls: 'ntn-title-text' });
			link.addEventListener('click', (evt) => {
				// Ctrl/Cmd always means "new tab", whatever `openMode` says.
				const modified = evt.ctrlKey || evt.metaKey;
				if (!modified && this.config.get('openMode') === 'panel') {
					this.openPagePanel(entry.file);
					return;
				}
				void this.app.workspace.openLinkText(entry.file.path, '', modified);
			});
			return;
		}

		const value = entry.getValue(prop);
		const editable = prop.startsWith('note.');
		const propName = prop.split('.').slice(1).join('.');

		// ---- Pills (lists, tags, user-selected select-like properties) ----
		if (this.pills.pillProps.has(prop)) {
			const disableColorColumns = this.config.get('disableColorColumns') as string[] || [];
			const useDefaultColor = !disableColorColumns.includes(prop);

			const wrap = td.createDiv({ cls: 'ntn-pills' });
			const items = valueToStrings(value);
			for (const item of items) {
				const pill = wrap.createSpan({ cls: 'ntn-pill' });
				this.applyPillColor(pill, item, useDefaultColor);
				pill.setText(item.replace(/^#/, '').split('/').pop() || '');
			}
			if (editable) {
				td.addClass('ntn-editable');
				td.addEventListener('click', () =>
					this.openSelectEditor(td, entry, prop, propName, useDefaultColor),
				);
				// Keep an open menu pointed at this re-rendered cell so
				// click-to-toggle keeps working after a write re-renders the table.
				this.selectEditor?.reanchorIfMatches(td, entry.file.path, prop);
			}
			return;
		}

		// ---- Checkboxes write straight back to frontmatter ----
		if (value instanceof BooleanValue) {
			const cb = td.createEl('input', { type: 'checkbox', cls: 'ntn-checkbox' });
			cb.checked = value.isTruthy();
			if (editable) {
				cb.addEventListener('change', () => {
					void this.writeProperty(entry.file, propName, cb.checked);
				});
			} else {
				cb.disabled = true;
			}
			return;
		}

		// ---- Plain values: native render, click-to-edit for note.* ----
		const cellEl = td.createDiv({ cls: 'ntn-cell' });
		if (value != null) { // Handle both null and undefined
			const raw = value.toString();
			// stripPath is for link/file paths only ("Folder/Note" -> "Note");
			// applying it to freeform text truncates any value that happens to
			// contain a "/" (a fraction, a date, a unit like "km/h", …).
			const strVal = (value instanceof LinkValue || value instanceof FileValue)
				? stripPath(raw)
				: raw;
			const metaType = getPropertyMetaType(this.app, prop);
			if (strVal && (!metaType || metaType === 'text' || metaType === 'multitext')) {
				void MarkdownRenderer.render(this.app, strVal, cellEl, entry.file.path, this);
			} else {
				value.renderTo(cellEl, this.app.renderContext);
			}
		}
		if (editable) {
			td.addClass('ntn-editable');
			const kind = value instanceof NumberValue ? 'number' : 'text';
			td.addEventListener('click', (evt) => {
				// Don't hijack clicks on links rendered inside the cell.
				if ((evt.target as HTMLElement).closest('a')) return;
				this.editCell(td, entry, propName, value ? value.toString() : '', kind);
			});
		}
	}

	/** Swap a cell's content for an input; commit on Enter/blur, cancel on Esc. */
	private editCell(
		td: HTMLElement,
		entry: BasesEntry,
		propName: string,
		current: string,
		kind: 'text' | 'number',
	): void {
		if (td.querySelector('.ntn-input')) return; // already editing
		// Size the editor to the cell as it currently renders, rather than a
		// fixed size — measure before emptying (which would collapse the cell).
		const rect = td.getBoundingClientRect();
		// A cell taller than a single line (wrapped long text) needs a textarea
		// so the text wraps and stays visible; a single-line <input> would just
		// scroll it horizontally. Numbers always use a single-line input.
		const multiline = kind === 'text' && rect.height > 40;
		td.empty();
		const input = multiline
			? td.createEl('textarea', { cls: 'ntn-input ntn-textarea' })
			: td.createEl('input', { type: 'text', cls: 'ntn-input' });
		input.setCssStyles({ width: `${rect.width}px`, height: `${rect.height}px` });
		input.value = current;
		input.focus();
		input.select();

		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			const raw = input.value.trim();
			// Unchanged value: no write fires, so Bases won't re-render — discard
			// the input ourselves, otherwise the edit box lingers in the cell.
			if (raw === current) {
				this.onDataUpdated();
				return;
			}
			let out: unknown = raw;
			if (kind === 'number') {
				const n = Number(raw);
				out = raw === '' ? null : (Number.isNaN(n) ? raw : n);
			} else if (raw === '') {
				out = null;
			}
			void this.writeProperty(entry.file, propName, out);
		};

		input.addEventListener('keydown', (ev: Event) => {
			const evt = ev as KeyboardEvent;
			if (evt.key === 'Enter' && !evt.shiftKey) {
				// Shift+Enter inserts a newline in the textarea; plain Enter commits.
				evt.preventDefault();
				commit();
			} else if (evt.key === 'Escape') {
				committed = true; // suppress blur commit
				this.onDataUpdated(); // re-render, discarding the edit
			}
		});
		input.addEventListener('blur', commit);
	}

	private async writeProperty(file: TFile, propName: string, value: unknown): Promise<void> {
		try {
			await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
				if (value === null) {
					delete fm[propName];
				} else {
					fm[propName] = value;
				}
			});
			// Bases reacts to the metadata change and calls onDataUpdated for us.
		} catch (e) {
			console.error(`${LOG_PREFIX} failed to write property`, propName, e);
			new Notice(`Couldn't update "${propName}".`);
			this.onDataUpdated();
		}
	}

	/**
	 * Reroute the core toolbar's New button to the page panel while this
	 * view is active. The button lives on the query controller, outside this
	 * view's DOM, so its menu's `open` is shadowed on the instance and
	 * restored on unload. `newItemMenu` is internal API — if it ever moves,
	 * the guard below simply leaves the core behavior untouched (and the
	 * footer "+ New" falls back to its own capture flow).
	 */
	private patchToolbarNew(): void {
		if (this.newButtonPatched) return;
		const menu = (this.queryCtrl as unknown as { newItemMenu?: CoreNewItemMenu })
			.newItemMenu;
		if (!menu || typeof menu.open !== 'function' || typeof menu.close !== 'function') {
			return;
		}

		const orig = menu.open.bind(menu);
		const patched = async (
			name?: string,
			fmProc?: (fm: Record<string, unknown>) => void,
		): Promise<void> => {
			// Phones already get a full-screen tab from the core flow.
			if (Platform.isPhone) return orig(name, fmProc);
			let created: TFile | undefined;
			const ref = this.app.vault.on('create', (file) => {
				if (file instanceof TFile) created = file;
			});
			// Keep the core popover invisible for the instant it exists.
			const body = this.rootEl.doc.body;
			body.addClass('ntn-hide-new-popover');
			try {
				// The core flow still creates the file (folder + filter
				// frontmatter) and opens its popover, hidden by the class above.
				await orig(name, fmProc);
			} finally {
				this.app.vault.offref(ref);
				menu.close(); // tear down the hidden popover
				body.removeClass('ntn-hide-new-popover');
			}
			if (created) this.openPagePanel(created);
		};

		menu.open = patched;
		this.newButtonPatched = true;
		this.register(() => {
			// The bound original behaves identically for any later caller.
			menu.open = orig;
			this.newButtonPatched = false;
		});
	}

	/**
	 * "+ New" flow: create the note through the core Bases flow — so it lands
	 * in the configured folder and gets the frontmatter implied by the view's
	 * filters — then edit it in the centered Notion-style page panel instead
	 * of the small popover Obsidian anchors to the toolbar's New button.
	 */
	private async createAndOpenPage(): Promise<void> {
		// On phones the core flow already opens the note in a full-screen
		// tab; with the toolbar patch in place, createFileForView routes
		// through the patched menu, which opens the panel for us.
		if (Platform.isPhone || this.newButtonPatched) {
			await this.createFileForView();
			return;
		}
		// createFileForView resolves with void, so capture the file it
		// creates through the vault's create event.
		let created: TFile | undefined;
		const ref = this.app.vault.on('create', (file) => {
			if (file instanceof TFile) created = file;
		});
		try {
			await this.createFileForView();
		} finally {
			this.app.vault.offref(ref);
		}
		if (!created) return;

		// Dismiss the toolbar-anchored popover the core flow opened; the core
		// new-item menu closes itself on any click outside the popover.
		const doc = this.rootEl.doc;
		if (doc.querySelector('.bases-new-item-popover')) doc.body.click();

		this.openPagePanel(created);
	}

	/** Open a note centered in the Notion-style page panel. */
	private openPagePanel(file: TFile): void {
		new NotePageModal(this.app, file, {
			applyColor: (pill, text) => this.applyPillColor(pill, text),
			write: (f, propName, value) => this.writeProperty(f, propName, value),
			isPillProp: (name) =>
				this.pills.pillProps.has(`note.${name}` as BasesPropertyId),
			isListProp: (name) =>
				this.pills.listProps.has(`note.${name}` as BasesPropertyId),
			openSelect: (opts) => this.openSelectAt(opts),
			reanchorSelect: (anchor, filePath, propName) =>
				void this.selectEditor?.reanchorIfMatches(
					anchor, filePath, `note.${propName}` as BasesPropertyId,
				),
			closeSelect: () => this.closeSelectMenu(),
		}).open();
	}

	/** Color a pill element using this view's pinned-color overrides. */
	private applyPillColor(pill: HTMLElement, text: string, useDefaultColor = true): void {
		applyPillColor(pill, text, this.pinnedColors, useDefaultColor);
	}

	/** Open the Notion-style select editor for a pill cell of the table. */
	private openSelectEditor(
		td: HTMLElement,
		entry: BasesEntry,
		prop: BasesPropertyId,
		propName: string,
		useDefaultColor = true,
	): void {
		this.openSelectAt({
			anchor: td,
			file: entry.file,
			propName,
			current: valueToStrings(entry.getValue(prop)),
			isList: this.pills.listProps.has(prop),
			useDefaultColor,
		});
	}

	/**
	 * Open the select editor anchored anywhere — a table cell or a property
	 * row of the page panel. Known values always come from the live query
	 * result; lifetime stays with the view (outside-click / Esc / unload).
	 */
	private openSelectAt(opts: OpenSelectOpts): void {
		// Clicking the element whose menu is already open toggles it shut.
		if (this.selectEditor?.anchorEl === opts.anchor) {
			this.closeSelectMenu();
			return;
		}
		this.closeSelectMenu();
		const prop = `note.${opts.propName}` as BasesPropertyId;
		this.selectEditor = new SelectEditor({
			doc: this.rootEl.doc,
			win: this.rootEl.win,
			anchor: opts.anchor,
			entries: this.data.data,
			file: opts.file,
			current: opts.current,
			prop,
			isList: opts.isList,
			applyColor: (pill, text) => this.applyPillColor(pill, text, opts.useDefaultColor ?? true),
			write: (value) =>
				void this.writeProperty(opts.file, opts.propName, value)
					.then(() => opts.onWrite?.()),
			setColor: (value, colorName) => this.setPinnedColor(value, colorName),
			getOrder: () => this.getSelectOptionOrder(opts.propName),
			setOrder: (order) => this.setSelectOptionOrder(opts.propName, order),
			onClose: () => { this.selectEditor = null; },
		});
	}

	/** Saved option order for a select/pill property (lowercased value keys). */
	private getSelectOptionOrder(propName: string): string[] {
		const map = this.config.get('selectOrders') as Record<string, string[]> | undefined;
		const order = map?.[propName];
		return Array.isArray(order) ? order.map((s) => String(s).toLowerCase()) : [];
	}

	/** Persist a select/pill property's option order, keyed by its bare name. */
	private setSelectOptionOrder(propName: string, order: string[]): void {
		const current = this.config.get('selectOrders') as Record<string, string[]> || {};
		this.config.set('selectOrders', { ...current, [propName]: order });
	}

	/**
	 * Pin a value to a specific Notion color. Updates the live map for instant
	 * feedback in the open editor, then persists into the `pinnedColors` view
	 * option (replacing any prior entry for the same value) so it survives
	 * reloads and is editable from the view settings too.
	 */
	private setPinnedColor(value: string, colorName: string): void {
		const bare = value.replace(/^#/, '');
		const key = bare.toLowerCase();
		
		if (colorName === 'default') {
			this.pinnedColors.delete(key);
		} else {
			const color = colorByName(colorName);
			if (!color) return;
			this.pinnedColors.set(key, color);
		}

		const raw = this.config.get('pinnedColors');
		const list = Array.isArray(raw) ? raw.map((s) => String(s)) : [];
		const kept = list.filter((item) => {
			const m = item.match(/^(.+?)\s*[=:]\s*(.+)$/);
			return m ? m[1].trim().replace(/^#/, '').toLowerCase() !== key : true;
		});
		
		if (colorName !== 'default') {
			kept.push(`${bare}=${colorName}`);
		}
		this.config.set('pinnedColors', kept);
	}

	private closeSelectMenu(): void {
		this.selectEditor?.close();
		this.selectEditor = null;
	}
}
