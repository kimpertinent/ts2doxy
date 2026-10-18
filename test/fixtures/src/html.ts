/**
 * Inline HTML in comments: a supported tag is markup only when it is balanced
 * in its section (or a void tag); otherwise it is shown literally.
 */

/** The #settings-list <table>. */
export const settingsList = 'settings-list';

/** Closes a tag it never opened: </b> here. */
export function loneClose(): void {}

/** Opens <b> and never closes it. */
export function loneOpen(): void {}

/** Kept: <b>bold</b>, a break<br>here, <br/> there, and a rule <hr> too. */
export function balanced(): void {}

/** Misnested: <b><i>both</b></i> -- only the bold pair nests. */
export function misnested(): void {}

/** Items close implicitly: <ul><li>first<li>second</ul> */
export function implicitItems(): void {}

/**
 * A real table:
 * <table>
 * <tr><td>cell</td></tr>
 * </table>
 */
export function realTable(): void {}

/** Bold around a link: <b>see {@link realTable}</b> for one. */
export function aroundLink(): void {}

/**
 * Opens <b>in the description
 * @returns and closes it here</b>, which Doxygen would not pair
 */
export function crossSection(): number {
  return 1;
}

/** Empty-tag form <b/> is rejected by Doxygen. */
export function emptyTag(): void {}

/** In code it is code: `<table>`; a lone <p> stays text. */
export function inCode(): void {}
