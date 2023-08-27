import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';

@customElement('track-insert-marker-view')
export class TrackInsertMarkerView extends LitElement {
  static styles = css`
.outer {
  position: relative;
}
.line {
  position: absolute;
  top: 0;
  height: 1px;
  left: var(--theme-row-group-head-width);
  right: 0;
  background-color: var(--theme-color5);
}
`;

  override render() {
    return html`
<div class="outer">
  <div class="line"></div>
</div>
    `;
  }
}
