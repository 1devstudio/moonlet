// What shows while the app loads (X40). Its layout is lib/splash.ts's, as
// the iOS launch screen's and index.html's static splash are, so starting
// the app has no jump.

import { SPLASH, logoTop, nameTop } from "../lib/splash";
import { Moon } from "./ui";

export function Splash() {
  return (
    <div className="relative h-full bg-bg" aria-label="moonlet is starting">
      <div className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 leading-none" style={{ top: logoTop }}>
        <Moon size={SPLASH.logo} />
      </div>
      <div className="absolute inset-x-0 text-center font-semibold text-fg" style={{ top: nameTop, fontSize: SPLASH.name, lineHeight: `${SPLASH.line}px` }}>
        moonlet
      </div>
    </div>
  );
}
