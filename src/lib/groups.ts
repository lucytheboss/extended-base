import { BasesEntry, BasesEntryGroup } from 'obsidian';

export interface GroupNode {
	key: string;
	fullKey: string;
	entries: BasesEntry[];
	children: Map<string, GroupNode>;
}

/**
 * Transforms a flat list of groups into a hierarchical tree of GroupNodes.
 */
export function buildGroupTree(groups: BasesEntryGroup[]): Map<string, GroupNode> {
	const roots = new Map<string, GroupNode>();

	for (const group of groups) {
		if (!group.hasKey() || !group.key) {
			roots.set('', { key: '', fullKey: '', entries: [...group.entries], children: new Map() });
			continue;
		}
		
		const rawKey = group.key.toString();
		const parts = rawKey.split('/');
		
		let currentMap = roots;
		let currentFullKey = '';

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			currentFullKey = currentFullKey ? `${currentFullKey}/${part}` : part;
			
			if (!currentMap.has(part)) {
				currentMap.set(part, {
					key: part,
					fullKey: currentFullKey,
					entries: [],
					children: new Map(),
				});
			}
			
			const node = currentMap.get(part)!;
			if (i === parts.length - 1) {
				node.entries.push(...group.entries);
			}
			
			currentMap = node.children;
		}
	}

	return roots;
}

export function countEntries(node: GroupNode): number {
	let count = node.entries.length;
	for (const child of node.children.values()) {
		count += countEntries(child);
	}
	return count;
}
