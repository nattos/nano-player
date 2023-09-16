import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';
import { adoptCommonStyleSheets } from './stylesheets';

@customElement('track-insert-marker-view')
export class TrackInsertMarkerView extends LitElement {
  override connectedCallback(): void {
    super.connectedCallback();
    adoptCommonStyleSheets(this);
  }

  override render() {
    return html`
<div class="track-insert-marker">
  <div class="track-insert-marker-line"></div>
</div>
    `;
  }
}
