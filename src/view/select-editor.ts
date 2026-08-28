/**
 * Notion-style select editor for pill cells: a floating menu showing the
 * cell's current values (removable), a search/create input, and every distinct
 * value used for the property across the table. List properties multi-select
 * (toggle, menu stays open); scalar pill properties single-select (pick and
 * close).
 *
 * The menu is self-contained: it captures a snapshot of the known values and
 * the editing entry's `file` at construction, never holding stale `BasesEntry`
 * objects, so it survives the view's `onDataUpdated` re-renders. The owning
 * view drives lifetime — outside-click and unload both call {@link close}.
 */
import { BasesEntry, BasesPropertyId, TFile, setIcon } from 'obsidian';
import { NOTION_COLORS, applyColorVars } from '../lib/colors';
import { valueToStrings } from '../lib/values';

export interface SelectEditorDeps {
	/** The view's own document (popout-safe; never bare `document`). */
	doc: Document;
	/** The view's own window (popout-safe), used to clamp the menu on screen. */
	win: Window;
	/** Cell element the menu anchors beneath. */
	anchor: HTMLElement;
	/** Every entry in the current result, used to list the known values. */
	entries: BasesEntry[];
	/** The file being edited (a `TFile` is stable across data updates). */
	file: TFile;
	/** The values currently set on the file, in display form. */
	current: string[];
	/** Property being edited. */
	prop: BasesPropertyId;
	/** True for list (multi-select) properties; false for scalar (single-select). */
	isList: boolean;
	/** Color a pill element for the given value. */
	applyColor: (pill: HTMLElement, text: string) => void;
	/** Persist the chosen value (`null` deletes the property). */
	write: (value: unknown) => void;
	/** Pin a value to a specific Notion color name (e.g. `"green"`). */
	setColor: (value: string, colorName: string) => void;
	/**
	 * The user's saved option order for this property (lowercased value
	 * keys), most-significant first. Drives both the order options list in
	 * and column sort-by-this-property elsewhere.
	 */
	getOrder: () => string[];
	/** Persist a new option order (lowercased value keys). */
	setOrder: (order: string[]) => void;
	/** Invoked once when the menu closes, so the owner can drop its reference. */
	onClose: () => void;
}

export class SelectEditor {
	private readonly menu: HTMLElement;
	/** Open color-picker flyout, if any (a sibling popover on the body). */
	private colorMenu: HTMLElement | null = null;
	private closed = false;

	/** Currently selected values (display form, leading `#` stripped). */
	private selected: string[];
	/** Distinct known values for this property: lowercase key → display text. */
	private readonly known = new Map<string, string>();
	/** Display order for `known`, lowercase keys, user-arranged via drag. */
	private orderKeys: string[];

	private pillsWrap!: HTMLElement;
	private optionsEl!: HTMLElement;
	private input!: HTMLInputElement;

	constructor(private readonly deps: SelectEditorDeps) {
		const { entries, current, prop } = deps;

		for (const e of entries) {
			for (const s of valueToStrings(e.getValue(prop))) {
				const display = s.replace(/^#/, '');
				if (display && !this.known.has(display.toLowerCase())) {
					this.known.set(display.toLowerCase(), display);
				}
			}
		}

		this.selected = current.map((s) => s.replace(/^#/, ''));
		this.orderKeys = this.buildInitialOrder();

		this.menu = this.build();
		this.position();
	}

	/** The saved order, plus any known value it doesn't mention yet, appended at the end. */
	private buildInitialOrder(): string[] {
		const stored = this.deps.getOrder().filter((k) => this.known.has(k));
		const seen = new Set(stored);
		const ordered = [...stored];
		for (const key of this.known.keys()) if (!seen.has(key)) ordered.push(key);
		return ordered;
	}

	/** Whether the given node lives inside the menu or its color flyout. */
	contains(node: Node | null): boolean {
		if (!node) return false;
		return this.menu.contains(node) || (this.colorMenu?.contains(node) ?? false);
	}

	/** The cell element this menu is anchored to (drives click-to-toggle). */
	get anchorEl(): HTMLElement {
		return this.deps.anchor;
	}

	/**
	 * Re-point the menu at a freshly rendered cell for the same file +
	 * property. `onDataUpdated` replaces every `td`, so without this the
	 * anchor would dangle on a detached node and click-to-toggle (which
	 * compares against the live cell) would miss. Returns whether it matched.
	 */
	reanchorIfMatches(td: HTMLElement, filePath: string, prop: BasesPropertyId): boolean {
		if (this.closed) return false;
		if (this.deps.prop !== prop || this.deps.file.path !== filePath) return false;
		this.deps.anchor = td;
		return true;
	}

	/** Tear the menu down. Idempotent; notifies the owner via `onClose`. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeColorMenu();
		this.menu.remove();
		this.deps.onClose();
	}

	private closeColorMenu(): void {
		this.colorMenu?.remove();
		this.colorMenu = null;
	}

	private build(): HTMLElement {
		const { doc, isList } = this.deps;
		const menu = doc.body.createDiv({ cls: 'ntn-root ntn-select-menu' });

		const currentEl = menu.createDiv({ cls: 'ntn-select-current' });
		this.pillsWrap = currentEl.createDiv({ cls: 'ntn-select-pills' });
		this.input = currentEl.createEl('input', {
			type: 'text',
			cls: 'ntn-select-input',
			attr: { placeholder: 'Search or create…', spellcheck: 'false' },
		});
		menu.createDiv({
			cls: 'ntn-select-hint',
			text: isList ? 'Select options or create one' : 'Select an option or create one',
		});
		this.optionsEl = menu.createDiv({ cls: 'ntn-select-options' });

		this.input.addEventListener('input', () => this.renderOptions());
		this.input.addEventListener('keydown', (evt) => this.onKeydown(evt));

		this.renderPills();
		this.renderOptions();
		this.input.focus();

		return menu;
	}

	/** Empty selection deletes the property (`write` treats `null` as delete). */
	private write(): void {
		const out: unknown = this.deps.isList
			? (this.selected.length ? this.selected : null)
			: (this.selected[0] ?? null);
		this.deps.write(out);
	}

	private renderPills(): void {
		this.pillsWrap.empty();
		for (const v of this.selected) {
			const pill = this.pillsWrap.createSpan({ cls: 'ntn-pill' });
			this.deps.applyColor(pill, v);
			pill.createSpan({ text: v.split('/').pop() || '' });
			const x = pill.createSpan({ cls: 'ntn-pill-remove', text: '✕' });
			x.addEventListener('click', (evt) => {
				evt.stopPropagation();
				this.selected = this.selected.filter((s) => s !== v);
				this.write();
				this.renderPills();
				this.renderOptions();
			});
		}
	}

	private pick(v: string): void {
		if (this.deps.isList) {
			const has = this.selected.some((s) => s.toLowerCase() === v.toLowerCase());
			this.selected = has
				? this.selected.filter((s) => s.toLowerCase() !== v.toLowerCase())
				: [...this.selected, v];
			if (!this.known.has(v.toLowerCase())) {
				this.known.set(v.toLowerCase(), v);
				this.orderKeys.push(v.toLowerCase());
			}
			this.write();
			this.input.value = '';
			this.renderPills();
			this.renderOptions();
			this.input.focus();
		} else {
			this.selected = [v];
			this.write();
			this.close();
		}
	}

	/** Move `key` next to `targetKey` (before/after) and persist the new order. */
	private reorderOption(key: string, targetKey: string, after: boolean): void {
		this.orderKeys = this.orderKeys.filter((k) => k !== key);
		let idx = this.orderKeys.indexOf(targetKey);
		if (idx === -1) idx = this.orderKeys.length;
		if (after) idx += 1;
		this.orderKeys.splice(idx, 0, key);
		this.deps.setOrder(this.orderKeys);
		this.renderOptions();
	}

	/** Press-and-drag on a row's grip handle to reorder the option list. */
	private startOptionDrag(startEvt: PointerEvent, key: string): void {
		const doc = this.deps.doc;
		const startX = startEvt.clientX;
		const startY = startEvt.clientY;
		let dragging = false;
		let dropRow: HTMLElement | null = null;
		let insertAfter = false;

		const clearIndicator = () => {
			dropRow?.removeClass('ntn-select-drop-before');
			dropRow?.removeClass('ntn-select-drop-after');
			dropRow = null;
		};

		const onMove = (ev: PointerEvent) => {
			if (!dragging) {
				if (Math.abs(ev.clientX - startX) < 4 && Math.abs(ev.clientY - startY) < 4) return;
				dragging = true;
			}
			const el = doc.elementFromPoint(ev.clientX, ev.clientY);
			const row = el?.closest('.ntn-select-option') as HTMLElement | null;
			clearIndicator();
			const targetKey = row?.getAttr('data-ntn-key');
			if (row && targetKey && targetKey !== key) {
				const rect = row.getBoundingClientRect();
				insertAfter = ev.clientY > rect.top + rect.height / 2;
				row.addClass(insertAfter ? 'ntn-select-drop-after' : 'ntn-select-drop-before');
				dropRow = row;
			}
		};

		const onUp = () => {
			doc.removeEventListener('pointermove', onMove);
			doc.removeEventListener('pointerup', onUp);
			const targetKey = dropRow?.getAttr('data-ntn-key');
			clearIndicator();
			if (dragging && targetKey && targetKey !== key) {
				this.reorderOption(key, targetKey, insertAfter);
			}
		};

		doc.addEventListener('pointermove', onMove);
		doc.addEventListener('pointerup', onUp);
	}

	private renderOptions(): void {
		this.closeColorMenu();
		this.optionsEl.empty();
		const q = this.input.value.trim();
		const ql = q.toLowerCase();
		const visible = this.orderKeys
			.filter((key) => this.known.has(key))
			.map((key) => [key, this.known.get(key) as string] as const)
			.filter(([, o]) => !ql || o.toLowerCase().includes(ql));
		for (const [key, o] of visible) {
			const row = this.optionsEl.createDiv({ cls: 'ntn-select-option', attr: { 'data-ntn-key': key } });

			// 0. Drag handle (hidden until hover — see styles.css)
			const grip = row.createSpan({ cls: 'ntn-select-grip', attr: { 'aria-label': 'Drag to reorder' } });
			setIcon(grip, 'grip-vertical');
			grip.addEventListener('pointerdown', (evt) => {
				evt.stopPropagation();
				this.startOptionDrag(evt, key);
			});
			grip.addEventListener('click', (evt) => evt.stopPropagation());

			// 1. Check mark (left)
			const isSelected = this.selected.some((s) => s.toLowerCase() === o.toLowerCase());
			row.createSpan({ cls: 'ntn-select-check', text: isSelected ? '✓' : '' });

			// 2. Pill (middle)
			const pill = row.createSpan({ cls: 'ntn-pill' });
			this.deps.applyColor(pill, o);
			pill.setText(o.split('/').pop() || '');

			// 3. Color square (right)
			const colorBtn = row.createSpan({
				cls: 'ntn-select-color-btn',
				attr: { 'aria-label': 'Change color' },
			});
			this.deps.applyColor(colorBtn, o);
			colorBtn.addEventListener('click', (evt) => {
				evt.stopPropagation();
				this.openColorMenu(colorBtn, o);
			});

			row.addEventListener('click', () => this.pick(o));
		}
		if (q && !this.known.has(ql)) {
			const row = this.optionsEl.createDiv({ cls: 'ntn-select-option' });
			row.createSpan({ cls: 'ntn-select-grip' }); // Empty: align with the grip column
			row.createSpan({ cls: 'ntn-select-create', text: '+' }); // Align with check
			const pill = row.createSpan({ cls: 'ntn-pill' });
			this.deps.applyColor(pill, q);
			pill.setText(q.split('/').pop() || '');
			row.addEventListener('click', () => this.pick(q));
		}
		if (!visible.length && !q) {
			this.optionsEl.createDiv({
				cls: 'ntn-select-empty',
				text: 'No options yet — type to create one',
			});
		}
	}

	private onKeydown(evt: KeyboardEvent): void {
		if (evt.key === 'Escape') {
			// Consume the key: inside the page panel, a bubbling Esc would
			// close the whole modal along with the menu.
			evt.preventDefault();
			evt.stopPropagation();
			this.close();
		} else if (evt.key === 'Enter') {
			const q = this.input.value.trim();
			if (q) this.pick(this.known.get(q.toLowerCase()) ?? q);
			else this.close();
		} else if (
			evt.key === 'Backspace' &&
			this.input.value === '' &&
			this.deps.isList &&
			this.selected.length
		) {
			this.selected = this.selected.slice(0, -1);
			this.write();
			this.renderPills();
			this.renderOptions();
		}
	}

	/** Open the color picker for a value, anchored to its row button. */
	private openColorMenu(anchorEl: HTMLElement, value: string): void {
		this.closeColorMenu();
		const menu = this.deps.doc.body.createDiv({ cls: 'ntn-root ntn-color-menu' });
		this.colorMenu = menu;

		const options = [{ name: 'default' }, ...NOTION_COLORS];
		for (const c of options) {
			const item = menu.createDiv({ cls: 'ntn-color-option' });
			const swatch = item.createSpan({ cls: 'ntn-color-swatch' });
			// "Default" leaves the swatch on the stylesheet's neutral colors,
			// which already track light/dark — only real palette entries
			// override them.
			if (c.name !== 'default') {
				applyColorVars(swatch, c as typeof NOTION_COLORS[0]);
			}
			item.createSpan({ cls: 'ntn-color-name', text: c.name.charAt(0).toUpperCase() + c.name.slice(1) });
			item.addEventListener('click', (evt) => {
				evt.stopPropagation();
				this.deps.setColor(value, c.name);
				// Live map is updated synchronously, so re-rendering shows the
				// new color immediately (renderOptions also closes this flyout).
				this.renderPills();
				this.renderOptions();
			});
		}

		this.clampToWindow(menu, anchorEl.getBoundingClientRect());
	}

	/** Anchor the main menu below the cell, then clamp into the window. */
	private position(): void {
		const rect = this.deps.anchor.getBoundingClientRect();
		this.menu.setCssStyles({ minWidth: `${Math.max(rect.width, 220)}px` });
		this.clampToWindow(this.menu, rect);
	}

	/** Place a popover just below `anchorRect`, nudged to stay on screen. */
	private clampToWindow(el: HTMLElement, anchorRect: DOMRect): void {
		const { win } = this.deps;
		el.setCssStyles({
			left: `${anchorRect.left}px`,
			top: `${anchorRect.bottom + 4}px`,
		});

		const rect = el.getBoundingClientRect();
		if (rect.bottom > win.innerHeight - 8) {
			el.setCssStyles({ top: `${Math.max(8, anchorRect.top - rect.height - 4)}px` });
		}
		if (rect.right > win.innerWidth - 8) {
			el.setCssStyles({ left: `${Math.max(8, win.innerWidth - rect.width - 8)}px` });
		}
	}
}
