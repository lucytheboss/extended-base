/**
 * Internal view-type ids registered with Obsidian. These appear in `.base`
 * files, so they must stay stable — changing one breaks existing bases.
 * `bases` is the table view's id as shipped in 1.0.0 and is kept for
 * compatibility, even though it does not match the plugin's public name.
 */
export const NOTION_TABLE_VIEW = 'bases';
export const NOTION_LIST_VIEW = 'notion-list';
export const NOTION_BOARD_VIEW = 'notion-board';

/** Prefix for every console message this plugin emits. */
export const LOG_PREFIX = '[extended-base]';
