import { html, css, LitElement, PropertyValueMap } from 'lit';
import {} from 'lit/html';
import { customElement, property } from 'lit/decorators.js';
import { NanoApp } from './app';
import { getLineAwesomeStyleSheet } from './stylesheets';
import { classMap } from 'lit/directives/class-map.js';
import * as utils from '../utils';

@customElement('simple-icon')
export class SimpleIconElement extends LitElement {
  static styles = css`
    :host {
      color: var(--theme-fg3);
      font-size: var(--theme-button-size);
      user-select: none;
    }
  `;

  @property() icon?: string;

  connectedCallback(): void {
    super.connectedCallback();
    const oldSheets = this.shadowRoot!.adoptedStyleSheets;
    const toInclude = getLineAwesomeStyleSheet();
    if (!oldSheets.includes(toInclude)) {
      this.shadowRoot!.adoptedStyleSheets = this.shadowRoot!.adoptedStyleSheets.concat([toInclude]);
    }
  }

  override render() {
    if (!this.icon) {
      return html``;
    }
    const iconClass = `la-${this.icon}`;
    const classes = classMap(utils.putKeyValues({'las': true}, [iconClass, 'true']));
    return html`
<i class=${classes}></i>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'simple-icon': SimpleIconElement;
  }
}
