import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { action } from 'mobx';
import * as utils from '../utils';
import './simple-icon-element';
import { Track } from './schema';
import { SelectionMode } from './selection';
import { Database } from './database';

export interface TrackViewHost {
  doSelectTrackView(trackView: TrackView, mode: SelectionMode): void;
  doPlayTrackView(trackView: TrackView): void;
  doPreviewMove(trackView: TrackView, delta: number): void;
  doAcceptMove(trackView: TrackView): void;
  doCancelMove(trackView: TrackView): void;
  doContextMenu(trackView: TrackView): void;
}

interface ExtendedMetadata {
  codec?: string;
  pathParts?: string[];
}

@customElement('track-view')
export class TrackView extends LitElement {
  static styles = css`
.click-target {
  user-select: none;
  cursor: pointer;
}
.hidden {
  display: none;
}

.row {
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
.row.even {
  background-color: var(--theme-row-even-bg);
}
.row.playing {
}
.row.highlighted {
  border-color: var(--theme-hi-border);
}
.row.selected {
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

.row-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  user-select: none;
  pointer-events: auto;
  opacity: 0.0;
}
.row-overlay:hover {
  opacity: 1.0;
}
.row-controls-container {
  position: absolute;
  top: -0.25em;
  right: 1.5em;
  bottom: -0.25em;
  pointer-events: auto;
}
.row-controls {
  z-index: 2;
  position: relative;
  display: flex;
  height: 100%;
  align-items: stretch;
}
.row-controls-underlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--theme-bg3);
  opacity: 1.0;
  z-index: 1;
}

.small-button {
  display: flex;
  aspect-ratio: 1 / 1;
}
.small-button:hover {
  background-color: var(--theme-color4);
}
.small-button-text {
  margin: auto;
  letter-spacing: var(--theme-letter-spacing-button);
}
`;

  @property() index = 0;
  @property() track?: Track;
  @property() selected = false;
  @property() highlighted = false;
  @property() playing = false;
  @property() showReorderControls = false;
  host?: TrackViewHost;

  private extendedMetadata: ExtendedMetadata = {};

  clicked(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    let selectMode: SelectionMode;
    if (e.metaKey || e.altKey) {
      selectMode = SelectionMode.Toggle;
    } else if (e.shiftKey) {
      selectMode = SelectionMode.SelectToRange;
    } else {
      selectMode = SelectionMode.Select;
    }
    this.host?.doSelectTrackView(this, selectMode);
  }

  @action
  async dblclick(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doPlayTrackView(this);
  }

  @action
  onContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.host?.doContextMenu(this);
  }

  @action
  doMoveUp(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doPreviewMove(this, -1);
  }

  @action
  doMoveDown(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doPreviewMove(this, 1);
  }

  @action
  doMoveAccept(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doAcceptMove(this);
  }

  @action
  doMoveCancel(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doCancelMove(this);
  }

  protected override update(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    if (changedProperties.has('track')) {
      this.updateExtendedMetadata();
    }
    super.update(changedProperties);
  }

  private updateExtendedMetadata() {
    const filePath = this.track?.filePath ?? '';
    this.extendedMetadata.codec = utils.filePathExtension(filePath).toUpperCase();
    const pathParts = filePath.split('/');
    this.extendedMetadata.pathParts = [pathParts?.at(-2) ?? '', pathParts?.at(-3) ?? '', pathParts?.at(-4) ?? ''];
  }

  private doStopPropagation(e: Event) {
    e.preventDefault();
    e.stopPropagation();
  }

  override render() {
    return html`
<div
    class=${classMap({
      'row': true,
      'even': (this.index % 2) === 0,
      'playing': this.playing,
      'selected': this.selected,
      'highlighted': this.highlighted,
    })}
    @mousedown=${this.clicked}
    @dblclick=${this.dblclick}
    @contextmenu=${this.onContextMenu}>
  <div class="col-index">${this.playing ? '_' : ''}${this.index}</div>
  <div class="col-title">${this.track?.metadata?.title}</div>
  <div class="col-duration">${utils.formatDuration(this.track?.metadata?.duration)}</div>
  <div class="col-artist">${this.track?.metadata?.artist}</div>
  <div class="col-album">${this.track?.metadata?.album}</div>
  <div class="col-track-number">${formatIntegerFraction(this.track?.metadata?.trackNumber, this.track?.metadata?.trackTotal)}</div>
  <div class="col-path-part">${this.extendedMetadata.pathParts?.at(0)}</div>
  <div class="col-path-part">${this.extendedMetadata.pathParts?.at(1)}</div>
  <div class="col-path-part">${this.extendedMetadata.pathParts?.at(2)}</div>
  <div class="col-codec">${this.extendedMetadata.codec}</div>
  <div
      class=${classMap({
        'row-overlay': true,
        'hidden': !(this.selected && this.highlighted && this.showReorderControls),
      })}>
    <div
        class="row-controls-container"
        @mousedown=${this.doStopPropagation}
        @click=${this.doStopPropagation}
        @dblclick=${this.doStopPropagation}>
      <div class="row-controls-underlay"></div>
      <div class="row-controls">
        <span class="small-button click-target" @click=${this.doMoveAccept}><div class="small-button-text"><simple-icon icon="check-circle"></simple-icon></div></span>
        <span class="small-button click-target" @click=${this.doMoveCancel}><div class="small-button-text"><simple-icon icon="times-circle"></simple-icon></div></span>
        <span class="small-button click-target" @click=${this.doMoveUp}><div class="small-button-text"><simple-icon icon="arrow-circle-up"></simple-icon></div></span>
        <span class="small-button click-target" @click=${this.doMoveDown}><div class="small-button-text"><simple-icon icon="arrow-circle-down"></simple-icon></div></span>
      </div>
    </div>
  </div>
</div>
    `;
  }
}

function formatIntegerFraction(numerator: number|undefined, denominator: number|undefined) {
  if (numerator === undefined) {
    return '';
  }
  if (denominator === undefined) {
    return `${numerator}`;
  }
  return `${numerator} / ${denominator}`;
}
