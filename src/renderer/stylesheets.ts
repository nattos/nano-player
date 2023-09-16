import './style.css';
import 'line-awesome/dist/line-awesome/css/line-awesome.css';
import * as utils from '../utils';

function toStyleSheet(styleElement: HTMLStyleElement): CSSStyleSheet {
  const styleSheet = new CSSStyleSheet();
  styleSheet.replaceSync(styleElement.innerText);
  return styleSheet;
}

const styleElements = Array.from(document.head.querySelectorAll('style').values()) as HTMLStyleElement[];
const commonStyles = toStyleSheet(styleElements[0]);
const lineAwesomeStyles = toStyleSheet(styleElements[1]);

export function getCommonStyleSheet(): CSSStyleSheet {
  return commonStyles;
}

export function getLineAwesomeStyleSheet(): CSSStyleSheet {
  return lineAwesomeStyles;
}

export function adoptCommonStyleSheets(element: HTMLElement) {
  adoptStyleSheets(element, getCommonStyleSheet());
}

export function adoptStyleSheets(element: HTMLElement, ...toAdopt: CSSStyleSheet[]) {
  if (!element.shadowRoot) {
    return;
  }
  const oldSheets = element.shadowRoot.adoptedStyleSheets;
  let newSheets: Iterable<CSSStyleSheet> = oldSheets;
  for (const sheet of toAdopt) {
    newSheets = utils.appendIfMissing(newSheets, sheet);
  }
  if (oldSheets === newSheets) {
    return;
  }
  element.shadowRoot.adoptedStyleSheets = Array.from(newSheets);
}
