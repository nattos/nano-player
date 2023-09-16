import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { action } from 'mobx';
import * as utils from '../utils';
import { Track } from './schema';
import { SelectionMode } from './selection';
import { ImageCache } from './ImageCache';
import { adoptCommonStyleSheets } from './stylesheets';

export interface TrackGroupViewHost {
  doPlayTrackGroupView(groupView: TrackGroupView): void;
  doSelectTrackGroupView(groupView: TrackGroupView, mode: SelectionMode): void;
}

@customElement('track-group-view')
export class TrackGroupView extends LitElement {
  @property() startIndex = 0;
  @property() endIndex = 0;
  @property() track?: Track;
  @property() imageUrl?: string;
  host?: TrackGroupViewHost;
  private imageLoadEpoch = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    adoptCommonStyleSheets(this);
  }

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
<div class="track-group">
  <div class="track-group-head">
    <div
        class="track-group-artwork click-target"
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
