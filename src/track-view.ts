import { html, css, LitElement } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { action } from 'mobx';
import * as utils from './utils';
import { Track } from './schema';
import { SelectionMode } from './selection';

export interface TrackViewHost {
  doSelectTrackView(trackView: TrackView, mode: SelectionMode): void;
  doPlayTrackView(trackView: TrackView): void;
}

@customElement('track-view')
export class TrackView extends LitElement {
  static styles = css`
.row {
  display: flex;
  width: calc(100% - 2px);
  height: calc(100% - 2px);
  gap: 1em;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-evenly;
  white-space: nowrap;
  user-select: none;
  border: solid 1px;
  border-color: transparent;
}
.row.selected {
  background-color: cornflowerblue;
}
.row.highlighted {
  border-color: coral;
}
.col-index {
  flex-grow: 1;
  width: 0;
  overflow:hidden;
}
.col-title {
  flex-grow: 15;
  width: 0;
  overflow:hidden;
}
.col-artist {
  flex-grow: 10;
  width: 0;
  overflow:hidden;
}
.col-album {
  flex-grow: 10;
  width: 0;
  overflow:hidden;
}
.col-duration {
  flex-grow: 2;
  width: 0;
  overflow:hidden;
}
.col-index-key {
  flex-grow: 10;
  width: 0;
  overflow:hidden;
}
`;

  @property() index = 0;
  @property() track?: Track;
  @property() selected = false;
  @property() highlighted = false;
  host?: TrackViewHost;

  clicked(e: MouseEvent) {
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
  async dblclick() {
    this.host?.doPlayTrackView(this);
  }

  override render() {
    return html`
<div
    class=${classMap({'row': true, 'selected': this.selected, 'highlighted': this.highlighted})}
    @mousedown=${this.clicked}
    @dblclick=${this.dblclick}>
  <div class="col-index">${this.index}</div>
  <div class="col-title">${this.track?.metadata?.title}</div>
  <div class="col-duration">${utils.formatDuration(this.track?.metadata?.duration)}</div>
  <div class="col-artist">${this.track?.metadata?.artist}</div>
  <div class="col-album">${this.track?.metadata?.album}</div>
  <div class="col-album">${this.track?.metadata?.trackNumber} / ${this.track?.metadata?.trackTotal}</div>
</div>
    `;
  }
}
