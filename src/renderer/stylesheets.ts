import 'line-awesome/dist/line-awesome/css/line-awesome.css';
import * as utils from '../utils';
import { css } from 'lit';

function toStyleSheet(styleElement: HTMLStyleElement): CSSStyleSheet {
  const styleSheet = new CSSStyleSheet();
  styleSheet.replaceSync(styleElement.innerText);
  return styleSheet;
}

const styleElements = Array.from(document.head.querySelectorAll('style').values()) as HTMLStyleElement[];
const lineAwesomeStyles = toStyleSheet(styleElements[0]);
let userBaseConfigStyleSheet: CSSStyleSheet|undefined;
let userDetailConfigStyleSheet: CSSStyleSheet|undefined;

export async function loadConfig() {
  userBaseConfigStyleSheet = (css({raw: [DEFAULT_BASE_CUSTOM_CSS], ...[DEFAULT_BASE_CUSTOM_CSS]})).styleSheet;
  userDetailConfigStyleSheet = (css({raw: [DEFAULT_DETAIL_CUSTOM_CSS], ...[DEFAULT_DETAIL_CUSTOM_CSS]})).styleSheet;
}

export function getBaseUserConfigStyleSheet(): CSSStyleSheet {
  if (!userBaseConfigStyleSheet) {
    throw new Error('Not yet loaded.');
  }
  return userBaseConfigStyleSheet;
}

export function getUserDetailConfigStyleSheet(): CSSStyleSheet {
  if (!userDetailConfigStyleSheet) {
    throw new Error('Not yet loaded.');
  }
  return userDetailConfigStyleSheet;
}

export function getLineAwesomeStyleSheet(): CSSStyleSheet {
  return lineAwesomeStyles;
}

export function adoptCommonStyleSheets(element: HTMLElement) {
  adoptStyleSheets(element, getBaseUserConfigStyleSheet(), getUserDetailConfigStyleSheet());
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


const DEFAULT_BASE_CUSTOM_CSS = `
body {
  --theme-color1: #051821;
  --theme-color2: #1A4645;
  --theme-color3: #266867;
  --theme-color4: #F58800;
  --theme-color5: #F8BC24;
  --theme-color-status-red: red;
  --theme-color-status-yellow: yellow;
  --theme-color-status-green: green;
  --theme-bg: #323232;
  --theme-bg2: #272727;
  --theme-bg3: #131313;
  --theme-bg4: #030303;
  --theme-fg: #FFFFFF;
  --theme-fg2: #E0E0E0;
  --theme-fg3: #C0C0C0;
  --theme-fg4: rgb(112, 112, 112);
  --theme-hi-bg: color-mix(in srgb-linear, var(--theme-color3) 20%, var(--theme-bg3));
  --theme-hi-fg: var(--theme-fg);
  --theme-hi-border: var(--theme-color5);
  --theme-row-odd-bg: var(--theme-bg);
  --theme-row-even-bg: var(--theme-bg2);
  --theme-letter-spacing-wide: 0.05em;
  --theme-letter-spacing-button: 0.1em;
  --theme-button-size: 24px;

  --theme-font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  --theme-font-weight: 300;
  --theme-font-size: 16px;

  --theme-player-height: 7em;
  --theme-row-group-head-width: var(--theme-player-height);
}
`;

const DEFAULT_DETAIL_CUSTOM_CSS = `
body {
  color: var(--theme-fg2);
  background-color: var(--theme-bg);
  font-family: var(--theme-font-family);
  font-weight: var(--theme-font-weight);
  font-size: var(--theme-font-size);
}

.hidden {
  visibility: hidden;
}

.click-target {
  user-select: none;
  cursor: pointer;
}

.small-button {
  display: flex;
  flex-grow: 1;
}
.small-button:hover {
  background-color: var(--theme-color4);
}
.small-button-text {
  margin: auto;
  letter-spacing: var(--theme-letter-spacing-button);
}
.small-button simple-icon {
  margin: auto;
}
simple-icon.green {
  color: var(--theme-color-status-green);
}
simple-icon.red {
  color: var(--theme-color-status-red);
}

input {
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  font-weight: 300;
  color: var(--theme-fg);
  background-color: var(--theme-bg);
  font-size: var(--theme-font-size);
  outline: none;
  border: none;
}

.code {
  white-space: pre;
  font-family: Monaco, monospace;
  font-size: 80%;
}

.horizontal-divider {
  background-color: var(--theme-color3);
  height: 0.5px;
}


.app {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-flow: column;
}
.app.window-deactive {
}

.window-title-bar {
  position: relative;
  height: 36px;
  width: 100%;
  user-select: none;
  -webkit-app-region: drag;
  color: var(--theme-fg3);
}
.window-title-divider {
  position: absolute;
  bottom: 0;
  height: 1px;
  left: 0;
  right: 0;
  background-color: var(--theme-bg2);
}
.app.window-deactive > .window-title-bar {
  color: var(--theme-fg4);
}
.window-title-text-container {
  --left-inset: max(var(--theme-row-group-head-width), 80px);
  display: flex;
  position: absolute;
  left: var(--left-inset);
  top: 0px;
  bottom: 0px;
  width: fit-content;
  max-width: calc(100% - var(--left-inset));
  align-items: center;
  gap: 1em;
  justify-content: flex-start;
  flex-wrap: nowrap;
}
.window-title-text-part {
  flex: 1 1 auto;
  text-wrap: nowrap;
  text-overflow: ellipsis;
  letter-spacing: var(--theme-letter-spacing-wide);
  font-size: 85%;
  overflow: hidden;
}
.window-title-text-part:empty {
  display: none;
}

.tracks-view-area {
  flex-grow: 1;
  height: 0;
  position: relative;
}
.tracks-view {
}

.player {
  position: relative;
  flex: none;
  background-color: var(--theme-bg2);
  width: 100%;
  height: var(--theme-player-height);
  display: grid;
  grid-auto-columns: auto minmax(0, 1fr) auto;
  grid-auto-rows: 0.6fr 1fr;
}
.player-divider {
  position: absolute;
  top: -1px;
  height: 1px;
  left: 0;
  right: 0;
  background-color: var(--theme-bg2);
}
.player-top-shade {
  position: absolute;
  bottom: 0;
  height: 3em;
  left: 0;
  right: 0;
  background: linear-gradient(0deg, color-mix(in srgb, transparent, var(--theme-bg4) 30%) 0%, transparent 100%);
  pointer-events: none;
}
.player-artwork {
  position: relative;
  height: var(--theme-player-height);
  width: var(--theme-player-height);
  background-color: var(--theme-bg3);
  grid-area: 1 / 1 / span 2 / span 1;
  background-position: center;
  background-size: cover;
}
.player-artwork-expand-overlay {
  position: absolute;
  bottom: 0;
  top: 0;
  left: 0;
  right: 0;
  opacity: 0;
}
.player-artwork-expand-overlay:hover {
  opacity: 1;
}
.player-artwork-expand-button {
  position: absolute;
  bottom: 0.2em;
  right: 0.2em;
  height: 2em;
  width: 2em;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background-color: var(--theme-bg4);
  opacity: 0.5;
}
.player-artwork-expand-button:hover {
  opacity: 1.0;
}
.player-info {
  display: flex;
  width: fit-content;
  max-width: 100%;
  align-items: center;
  margin: 0 1em;
  gap: 1em;
}
.player-info > div {
  flex-shrink: 1;
  flex-grow: 1;
  flex-basis: auto;
  text-wrap: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}
.player-title {}
.player-artist {}
.player-album {}
.player-seekbar {
  grid-area: 2 / 2 / span 1 / span 3;
  background-color: var(--theme-bg2);
}
.player-seekbar-bar {
  height: 100%;
  background-color: var(--theme-color4);
}
.player-controls {
  display: flex;
  margin: 0 3em 0 1em;
  align-items: stretch;
  justify-content: flex-end;
  width: 15em;
  white-space: nowrap;
}

.query-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}

.query-input-underlay {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 0;
  background-color: var(--theme-bg4);
  opacity: 0.5;
  user-select: none;
  pointer-events: auto;
}

.query-input-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-flow: column;
}

.query-input-area {
  position: relative;
  height: 4em;
  background-color: var(--theme-bg);
  margin: 2em 10em;
  min-width: 300px;
  border-radius: 2em;
  border: solid var(--theme-fg2) 1px;
  pointer-events: auto;
}

.query-input-icon {
  position: absolute;
  top: 50%;
  left: 2.5em;
  transform: translate(-100%, -50%);
}

.query-input {
  position: relative;
  bottom: 0.075em;
  width: calc(100% - 3em);
  height: 100%;
  font-size: 200%;
  background-color: transparent;
  margin: 0px 1.5em;
}

.query-completion-area {
  display: flex;
  justify-content: center;
  gap: 1em;
  font-size: 200%;
  flex-flow: wrap;
  width: 80%;
  align-self: center;
  align-items: center;
}

.query-completion-chip {
  overflow: hidden;
  text-wrap: nowrap;
  text-overflow: ellipsis;
  background-color: var(--theme-color2);
  border-radius: 1.5em;
  padding: 0.5em 1em;
  pointer-events: auto;
}

.query-completion-chip:hover {
  background-color: var(--theme-color4);
}

.query-completion-chip.special {
  background-color: var(--theme-color3);
}

.query-completion-chip.special:hover {
  background-color: var(--theme-color4);
}

.query-completion-chip-label {
}

.query-completion-chip-tag {
  font-size: 40%;
  letter-spacing: var(--theme-letter-spacing-wide);
  font-weight: 400;
}


.overlay-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
}
.overlay-underlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--theme-bg4);
  opacity: 0.66;
  user-select: none;
  pointer-events: auto;
}
.overlay-content {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}
.overlay-album-art-content {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: 70%;
  min-width: 30%;
  min-height: 30%;
  object-fit: contain;
  background-color: var(--theme-bg4);
  transform: translate(-50%, -50%);
  pointer-events: auto;
}

.screaming-headline-text {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: 70%;
  min-height: 30%;
  transform: translate(-50%, -50%);
  font-size: 400%;
  text-align: center;
}
.screaming-headline-text simple-icon {
  font-size: 200%;
}

.dialog {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 80%;
  height: 80%;
  display: grid;
  grid-auto-columns: 1fr auto;
  grid-auto-rows: max-content 1fr;
  background-color: var(--theme-bg2);
  pointer-events: auto;
}
.dialog-close-button {
  grid-area: 1 / 2 / span 1 / span 1;
  display: flex;
  width: 3em;
  height: 2em;
}
.dialog-title {
  grid-area: 1 / 1 / span 1 / span 1;
  margin-top: auto;
  margin-bottom: auto;
  margin-left: 0.25em;
}
.dialog-content {
  grid-area: 2 / 1 / span 1 / span 2;
  margin-left: 0.25em;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}



.track-view {
  position: relative;
  display: flex;
  width: calc(100% - 2px - var(--theme-row-group-head-width));
  height: calc(100% - 2px);
  left: var(--theme-row-group-head-width);
  gap: 1em;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-evenly;
  white-space: nowrap;
  user-select: none;
  border: solid 1px;
  border-color: transparent;
  background-color: var(--theme-row-odd-bg);
}
.track-view.even {
  background-color: var(--theme-row-even-bg);
}
.track-view.playing {
}
.track-view.highlighted {
  border-color: var(--theme-hi-border);
}
.track-view.selected {
  background-color: var(--theme-hi-bg);
}
.col-group-head {
  width: var(--theme-row-group-head-width);
}
.col-index {
  flex-grow: 0.1;
  width: 3em;
  overflow: hidden;
  text-align: right;
}
.col-title {
  flex-grow: 15;
  width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.col-artist {
  flex-grow: 10;
  width: 0;
  overflow:hidden;
  text-overflow: ellipsis;
}
.col-album {
  flex-grow: 10;
  width: 0;
  overflow:hidden;
  text-overflow: ellipsis;
}
.col-duration {
  flex-grow: 2;
  width: 0;
  overflow:hidden;
  text-overflow: ellipsis;
  text-align: right;
}
.col-track-number {
  flex-grow: 2;
  width: 0;
  overflow:hidden;
  text-overflow: ellipsis;
  text-align: right;
}
.col-index-key {
  flex-grow: 10;
  width: 0;
  overflow:hidden;
  text-overflow: ellipsis;
}
.col-path-part {
  flex-grow: 0.1;
  width: 3em;
  overflow:hidden;
  text-overflow: ellipsis;
}
.col-codec {
  flex-grow: 1;
  width: 3em;
  overflow:hidden;
  text-overflow: ellipsis;
}

.track-view-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  user-select: none;
  pointer-events: auto;
  opacity: 0.0;
}
.track-view-overlay:hover {
  opacity: 1.0;
}
.track-view-controls-container {
  position: absolute;
  top: -0.25em;
  right: 1.5em;
  bottom: -0.25em;
  pointer-events: auto;
}
.track-view-controls {
  z-index: 2;
  position: relative;
  display: flex;
  height: 100%;
  align-items: stretch;
}
.track-view-controls .small-button {
  aspect-ratio: 1 / 1;
}
.track-view-controls-underlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--theme-bg3);
  opacity: 1.0;
  z-index: 1;
}



.track-group {
  display: flex;
  width: 100%;
  height: 100%;
  gap: 1em;
  white-space: nowrap;
  user-select: none;
  pointer-events: none;
}
.track-group-head {
  position: relative;
  width: var(--theme-row-group-head-width);
  overflow: hidden;
  background: linear-gradient(180deg, var(--theme-row-even-bg), var(--theme-row-even-bg) 0.2em, transparent 0.2em, transparent);
  pointer-events: auto;
}
.track-group-artwork {
  position: absolute;
  top: 0.66em;
  left: 0.66em;
  right: 0.66em;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background-color: var(--theme-bg2);
  background-position: center;
  background-size: cover;
}


.track-insert-marker-outer {
  position: relative;
}
.track-insert-marker-line {
  position: absolute;
  top: 0;
  height: 1px;
  left: var(--theme-row-group-head-width);
  right: 0;
  background-color: var(--theme-color5);
}
`;
