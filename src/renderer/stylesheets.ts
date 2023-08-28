import './style.css';
import 'line-awesome/dist/line-awesome/css/line-awesome.css';
import * as utils from '../utils';

function toStyleSheet(styleElement: HTMLStyleElement): CSSStyleSheet {
  const styleSheet = new CSSStyleSheet();
  styleSheet.replaceSync(styleElement.innerText);
  return styleSheet;
}

const styleElements = Array.from(document.head.querySelectorAll('style').values()) as HTMLStyleElement[];
const lineAwesomeStyles = toStyleSheet(styleElements[1]);

export function getLineAwesomeStyleSheet(): CSSStyleSheet {
  return lineAwesomeStyles;
}
