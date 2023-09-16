import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { action } from 'mobx';
import * as utils from '../utils';
import './simple-icon-element';
import { Track } from './schema';
import { SelectionMode } from './selection';
import { PointerDragOp } from './pointer-drag-op';
import { adoptCommonStyleSheets } from './stylesheets';

export interface ListPos {
  afterIndex: number;
  beforeIndex: number;
  closestExistingIndex: number;
  isAtStart: boolean;
  isAtEnd: boolean;
}

export interface TrackViewHost {
  doSelectTrackView(trackView: TrackView, mode: SelectionMode): void;
  doSelectTrackIndex(index: number, mode: SelectionMode): void;
  doPlayTrackView(trackView: TrackView): void;
  doPreviewMove(trackView: TrackView, delta: number, isAbsolute: boolean): void;
  doAcceptMove(trackView: TrackView): void;
  doCancelMove(trackView: TrackView): void;
  doContextMenu(trackView: TrackView): void;
  pagePointToListPos(pageX: number, pageY: number): ListPos;
}

interface ExtendedMetadata {
  codec?: string;
  pathParts?: string[];
}

@customElement('track-view')
export class TrackView extends LitElement {
  static styles = css`

`;

  @property() index = 0;
  @property() track?: Track;
  @property() selected = false;
  @property() highlighted = false;
  @property() playing = false;
  @property() showReorderControls = false;
  host?: TrackViewHost;

  private extendedMetadata: ExtendedMetadata = {};
  private rangeSelectOp?: PointerDragOp;
  private dragMoveOp?: PointerDragOp;
  private dragMoveDidStart = false;

  override connectedCallback(): void {
    super.connectedCallback();
    adoptCommonStyleSheets(this);
  }

  clicked(e: PointerEvent) {
    if (e.button !== 0) {
      return;
    }
    const wasSelected = this.selected;
    let selectMode: SelectionMode;
    let beginRangeSelect = false;
    if (e.metaKey || e.altKey) {
      selectMode = SelectionMode.Toggle;
    } else if (e.shiftKey) {
      selectMode = SelectionMode.SelectToRange;
    } else {
      if (wasSelected) {
        selectMode = SelectionMode.SetPrimary;
      } else {
        selectMode = SelectionMode.Select;
      }
      beginRangeSelect = true;
    }
    this.host?.doSelectTrackView(this, selectMode);

    if (beginRangeSelect) {
      if (wasSelected) {
        if (this.showReorderControls) {
          this.dragMoveOp?.dispose();
          this.dragMoveDidStart = false;
          this.dragMoveOp = new PointerDragOp(e, this, {
            move: this.dragMovePreviewToPointer.bind(this),
            accept: this.dragMoveAccept.bind(this),
            cancel: this.dragMoveCancel.bind(this),
          });
        }
      } else {
        this.rangeSelectOp?.dispose();
        this.rangeSelectOp = new PointerDragOp(e, this, {
          move: this.rangeSelectToPointer.bind(this),
        });
      }
    }
  }

  @action
  rangeSelectToPointer(e: PointerEvent) {
    if (!this.host) {
      return;
    }
    const pos = this.host.pagePointToListPos(e.pageX, e.pageY);
    this.host?.doSelectTrackIndex(pos.closestExistingIndex, SelectionMode.SelectToRange);
  }

  @action
  dragMovePreviewToPointer(e: PointerEvent) {
    if (!this.host) {
      return;
    }
    const pos = this.host.pagePointToListPos(e.pageX, e.pageY);
    if (pos.afterIndex !== this.index && pos.beforeIndex !== this.index) {
      this.dragMoveDidStart = true;
    }
    if (this.dragMoveDidStart) {
      this.host.doPreviewMove(this, pos.beforeIndex, true);
    }
  }

  @action
  dragMoveAccept() {
    if (this.dragMoveDidStart) {
      this.host?.doAcceptMove(this);
    }
  }

  @action
  dragMoveCancel() {
    if (this.dragMoveDidStart) {
      this.host?.doCancelMove(this);
    }
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
    this.host?.doPreviewMove(this, -1, false);
  }

  @action
  doMoveDown(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doPreviewMove(this, 1, false);
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
      'track-view': true,
      'even': (this.index % 2) === 0,
      'playing': this.playing,
      'selected': this.selected,
      'highlighted': this.highlighted,
    })}
    @pointerdown=${this.clicked}
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
        'track-view-overlay': true,
        'hidden': !(this.selected && this.highlighted && this.showReorderControls),
      })}>
    <div
        class="track-view-controls-container"
        @mousedown=${this.doStopPropagation}
        @pointerdown=${this.doStopPropagation}
        @click=${this.doStopPropagation}
        @dblclick=${this.doStopPropagation}>
      <div class="track-view-controls-underlay"></div>
      <div class="track-view-controls">
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
