/**
 * Extended Base plugin entry point. Registers the table, list, and board
 * Bases views; all rendering and editing lives in `./view`, and reusable,
 * Obsidian-agnostic helpers live in `./lib`.
 */
import { Notice, Plugin } from 'obsidian';
import { NOTION_TABLE_VIEW, NOTION_LIST_VIEW, NOTION_BOARD_VIEW } from './constants';
import { buildViewOptions, buildListViewOptions, buildBoardViewOptions } from './view-options';
import { NotionTableView } from './view/notion-table-view';
import { NotionListView } from './view/notion-list-view';
import { NotionBoardView } from './view/notion-board-view';

export default class NotionBasesPlugin extends Plugin {
	async onload() {
		if (typeof this.registerBasesView !== 'function') {
			new Notice('Extended Base: requires Obsidian 1.10.0+ (registerBasesView API missing).', 8000);
			return;
		}
		const okTable = this.registerBasesView(NOTION_TABLE_VIEW, {
			name: 'Notion Table',
			icon: 'table-2',
			factory: (controller, containerEl) =>
				new NotionTableView(controller, containerEl),
			options: buildViewOptions,
		});

		const okList = this.registerBasesView(NOTION_LIST_VIEW, {
			name: 'Notion List',
			icon: 'list',
			factory: (controller, containerEl) =>
				new NotionListView(controller, containerEl),
			options: buildListViewOptions,
		});

		const okBoard = this.registerBasesView(NOTION_BOARD_VIEW, {
			name: 'Notion Board',
			icon: 'columns',
			factory: (controller, containerEl) =>
				new NotionBoardView(controller, containerEl),
			options: buildBoardViewOptions,
		});

		if (!okTable || !okList || !okBoard) {
			new Notice(
				`Extended Base: view registration failed (table=${okTable}, list=${okList}, board=${okBoard}). Is the Bases core plugin enabled?`,
				8000,
			);
		}
	}
}
