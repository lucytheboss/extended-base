/**
 * Property type lookup, shared by the table, list, and board views.
 *
 * Obsidian's `metadataTypeManager` is not part of the public API, so the
 * shape we depend on is declared here and every access is optional —
 * a missing manager just falls back to the generic text icon.
 */
import { App } from 'obsidian';

/** The property descriptor `getPropertyInfo` returns, as far as we use it. */
interface PropertyInfo {
	widget?: string;
	type?: string;
}

/** The slice of the internal `metadataTypeManager` this plugin relies on. */
interface MetadataTypeManager {
	getPropertyInfo?(name: string): PropertyInfo | string | undefined;
}

interface AppWithMetadataTypes extends App {
	metadataTypeManager?: MetadataTypeManager;
}

/** Strip the `note.` / `file.` prefix a Bases property id carries. */
function bareName(prop: string): string {
	return prop.split('.').slice(1).join('.').toLowerCase();
}

/**
 * The registered type of a property (`text`, `number`, `date`, …), or
 * undefined when Obsidian has no record of it.
 */
export function getPropertyMetaType(app: App, prop: string): string | undefined {
	const mtm = (app as AppWithMetadataTypes).metadataTypeManager;
	const info = mtm?.getPropertyInfo?.(bareName(prop));
	if (typeof info === 'string') return info;
	return info?.widget ?? info?.type;
}

/** The Lucide icon name to show in a column header for this property. */
export function getPropertyIcon(app: App, prop: string): string {
	if (prop.startsWith('file.') && bareName(prop) === 'name') return 'file-text';

	switch (getPropertyMetaType(app, prop)) {
		case 'number':
			return 'hash';
		case 'checkbox':
			return 'check-square';
		case 'date':
		case 'datetime':
			return 'calendar';
		case 'multitext':
		case 'tags':
		case 'aliases':
			return 'tags';
		default:
			return 'type';
	}
}
