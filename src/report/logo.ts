// packlight's mark: a solid front-view backpack with a small handle, low side pockets and a green front pocket.
// The flap, clasp and pocket outline are cut out with a mask, so they show whatever sits behind the mark.
// client.ts draws the same shapes with DOM calls (it cannot import); keep the two in step.

export const BRAND_GREEN = '#3fae6e';

/** The mark as standalone SVG markup. `tile` puts it on a rounded square (app icon, favicon). */
export function logoSvg(opts: { ink: string; tile?: string; id?: string }): string {
  const id = opts.id ?? 'pl-cut';
  const glyph = `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">`
    + '<rect width="64" height="64" fill="#fff"/>'
    + '<path d="M15.5 34v19M48.5 34v19" stroke="#000" stroke-width="2.5"/>'
    + '<path d="M22 15.5v7.5a5 5 0 0 0 5 5h10a5 5 0 0 0 5-5v-7.5" fill="none" stroke="#000" stroke-width="3"/>'
    + '<rect x="29" y="23" width="6" height="8" rx="2" fill="#000"/>'
    + '<rect x="22" y="39" width="20" height="20" rx="4" fill="none" stroke="#000" stroke-width="3"/>'
    + `</mask></defs><g mask="url(#${id})" fill="${opts.ink}">`
    + `<path d="M28 13v-2a4 4 0 0 1 8 0v2" fill="none" stroke="${opts.ink}" stroke-width="4"/>`
    + '<rect x="10" y="35" width="10" height="17" rx="3.5"/><rect x="44" y="35" width="10" height="17" rx="3.5"/>'
    + '<rect x="16" y="12" width="32" height="47" rx="7"/></g>'
    + `<rect x="24.5" y="41.5" width="15" height="17.5" rx="2" fill="${BRAND_GREEN}"/>`;
  const body = opts.tile
    ? `<rect width="64" height="64" rx="14" fill="${opts.tile}"/><g transform="translate(5 4) scale(.84)">${glyph}</g>`
    : glyph;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
}
