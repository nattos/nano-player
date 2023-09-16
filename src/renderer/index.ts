import { NanoApp } from './app';
import * as stylesheets from './stylesheets';

(async () => {
  await stylesheets.loadConfig();
  document.adoptedStyleSheets = document.adoptedStyleSheets.concat([stylesheets.getBaseUserConfigStyleSheet(), stylesheets.getUserDetailConfigStyleSheet()]);
  document.body.appendChild(new NanoApp());
})();

export const instance = NanoApp.instance;
