import { html, css, LitElement } from 'lit';
import {} from 'lit/html';
import { customElement, property} from 'lit/decorators.js';
import { action } from 'mobx';
import * as utils from './utils';
import { Track } from './schema';

export interface TrackViewHost {
  doPlayTrackView(trackView: TrackView): void;
}

@customElement('track-view')
export class TrackView extends LitElement {
  static styles = css`
.row {
  display: flex;
  width: 100%;
  height: 100%;
  gap: 1em;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: space-evenly;
  white-space: nowrap;
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
  host?: TrackViewHost;

  @action
  async dblclick() {
    this.host?.doPlayTrackView(this);
  }

  override render() {
    return html`
<div class="row" @dblclick=${this.dblclick}>
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
