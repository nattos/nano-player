import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { action } from 'mobx';
import * as utils from '../utils';
import { Track } from './schema';
import { SelectionMode } from './selection';
import { Database } from './database';
import { ImageCache } from './ImageCache';

export interface TrackGroupViewHost {
  doPlayTrackGroupView(groupView: TrackGroupView): void;
  doSelectTrackGroupView(groupView: TrackGroupView, mode: SelectionMode): void;
}

@customElement('track-group-view')
export class TrackGroupView extends LitElement {
  static styles = css`
.click-target {
  user-select: none;
  cursor: pointer;
}

.group {
  display: flex;
  width: 100%;
  height: 100%;
  gap: 1em;
  white-space: nowrap;
  user-select: none;
  pointer-events: none;
}
.group-head {
  position: relative;
  width: var(--theme-row-group-head-width);
  overflow: hidden;
  background: linear-gradient(180deg, var(--theme-row-even-bg), var(--theme-row-even-bg) 0.2em, transparent 0.2em, transparent);
  pointer-events: auto;
}
.artwork {
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
`;

  @property() startIndex = 0;
  @property() endIndex = 0;
  @property() track?: Track;
  @property() imageUrl?: string;
  host?: TrackGroupViewHost;
  private imageLoadEpoch = 0;

  clicked(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doSelectTrackGroupView(this, SelectionMode.Select);
  }

  @action
  async dblclick(e: MouseEvent) {
    if (e.button !== 0) {
      return;
    }
    this.host?.doPlayTrackGroupView(this);
  }

  override render() {
    return html`
<div class="group">
  <div class="group-head">
    <div
        class="artwork click-target"
        @mousedown=${this.clicked}
        @dblclick=${this.dblclick}
        style=${styleMap({
          'background-image': this.imageUrl ? `url(${this.imageUrl})` : undefined,
        })}>
    </div>
  </div>
</div>
    `;
  }

  protected override update(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    const newTrack = this.track;
    if (changedProperties.has('track') && newTrack) {
      const thisImageLoadEpoch = ++this.imageLoadEpoch;
      let didLoad = false;
      let isStillUpdating = true;
      if (newTrack.coverArt) {
        const coverArt = newTrack.coverArt;
        (async () => {
          const url = await ImageCache.instance.getImageUrl(coverArt);
          if (thisImageLoadEpoch === this.imageLoadEpoch) {
            if (isStillUpdating) {
              changedProperties.set('imageUrl', url);
            }
            this.imageUrl = url;
            didLoad = true;
          }
        })();
        if (!didLoad && this.imageUrl) {
          changedProperties.set('imageUrl', undefined);
          this.imageUrl = undefined;
        }
        isStillUpdating = false;
      } else {
        if (this.imageUrl) {
          changedProperties.set('imageUrl', undefined);
          this.imageUrl = undefined;
        }
      }
    }
    super.update(changedProperties);
  }
}
