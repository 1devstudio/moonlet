// The splash's layout (X40), shared by the in-app splash (Splash.tsx), the
// static splash index.html shows before the script runs (made by the Vite
// plugin from splashHtml), and checked against the iOS launch screen
// (src-tauri/gen/apple/LaunchScreen.storyboard), so the three line up.

export const SPLASH = {
  /** The logo's width and height, points. */
  logo: 132,
  /** How far the logo's centre sits above the screen's centre. */
  lift: 36,
  /** Between the logo and the name. */
  gap: 16,
  /** The name's font size and line height. */
  name: 30,
  line: 36,
};

/** Where the logo's centre and the name's top are, as CSS `top` values. */
export const logoTop = `calc(50% - ${SPLASH.lift}px)`;
export const nameTop = `calc(50% - ${SPLASH.lift}px + ${SPLASH.logo / 2}px + ${SPLASH.gap}px)`;

/** The splash as static HTML around `svg`, the logo's artwork. */
export function splashHtml(svg: string): string {
  const logo = svg.replace(/^<svg/, `<svg width="${SPLASH.logo}" height="${SPLASH.logo}"`);
  return [
    `<div style="position: relative; height: 100%">`,
    `<div style="position: absolute; left: 50%; top: ${logoTop}; transform: translate(-50%, -50%); line-height: 0">${logo}</div>`,
    `<div style="position: absolute; left: 0; right: 0; top: ${nameTop}; text-align: center; font: 600 ${SPLASH.name}px/${SPLASH.line}px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #e6e6e6">moonlet</div>`,
    `</div>`,
  ].join("");
}
