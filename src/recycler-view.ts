import {html, LitElement, PropertyValueMap} from 'lit';
import {} from 'lit/html';
import {customElement, property, query} from 'lit/decorators.js';
import {styleMap} from 'lit-html/directives/style-map.js';
import {action, observable, makeObservable} from 'mobx';

export function init() {}

@customElement('recycler-view')
export class RecyclerView<TElement extends HTMLElement, TData> extends LitElement {
  private static readonly elementCollectCountWaterlevel = 10;

  @query('#scroll-container') scrollContainer!: HTMLElement;
  @query('#content-area') contentArea!: HTMLElement;

  @property() rowHeight = 42;
  @property() totalCount = 100;
  elementConstructor?: () => TElement;
  elementDataSetter?: (element: TElement, index: number, data: TData|undefined) => void;
  dataGetter?: (index: number) => TData|undefined;

  @observable viewportMinIndex = 0;
  @observable viewportMaxIndex = 0;

  private didReady = false;
  private elementsDisplayedMap = new Map<number, TElement>();
  private elementFreePool: TElement[] = [];

  constructor() {
    super();
    makeObservable(this);
  }

  ready() {
    if (this.didReady || !this.contentArea || !this.elementConstructor || !this.elementDataSetter || !this.dataGetter) {
      return;
    }
    this.didReady = true;
  }

  get elementsInView(): TElement[] {
    return Array.from(this.elementsDisplayedMap.values());
  }

  rangeUpdated(min: number, max: number) {
    for (let i = min; i <= max; ++i) {
      const element = this.elementsDisplayedMap.get(i);
      if (element === undefined) {
        continue;
      }
      this.elementDataSetter?.(element, i, this.dataGetter?.(i));
    }
  }

  private ensureElement(index: number): TElement|undefined {
    let element = this.elementsDisplayedMap.get(index);
    if (element !== undefined) {
      return element;
    }
    element = this.elementFreePool.pop();
    if (element === undefined) {
      element = this.elementConstructor?.();
      if (element === undefined) {
        return undefined;
      }
    }
    element.style['position'] = 'absolute';
    element.style['height'] = `${this.rowHeight}px`;
    element.style['top'] = `${this.rowHeight * index}px`;
    element.style['width'] = `100%`;
    this.contentArea.appendChild(element);
    this.elementsDisplayedMap.set(index, element);

    this.elementDataSetter?.(element, index, this.dataGetter?.(index));
    return element;
  }

  private freeElement(index: number) {
    let element = this.elementsDisplayedMap.get(index);
    if (element === undefined) {
      return;
    }
    this.elementsDisplayedMap.delete(index);
    this.elementFreePool.push(element);
    element.remove();
  }

  @action
  private onScroll() {
    this.updateViewport();
  }

  private updateViewport() {
    const scrollTop = this.scrollContainer!.scrollTop;
    const scrollBottom = scrollTop + this.scrollContainer!.clientHeight;
    const viewportMinIndex = Math.floor(scrollTop / this.rowHeight);
    const viewportMaxIndex = Math.ceil(scrollBottom / this.rowHeight);

    if (this.didReady) {
      for (let i = viewportMinIndex; i < viewportMaxIndex; ++i) {
        this.ensureElement(i);
      }
      const collectWaterlevel = viewportMaxIndex - viewportMinIndex + RecyclerView.elementCollectCountWaterlevel;
      if (this.elementsDisplayedMap.size > collectWaterlevel) {
        // Sweep elements.
        const toCollect = [];
        for (const [index, value] of this.elementsDisplayedMap) {
          if (index < viewportMinIndex || index > viewportMaxIndex) {
            toCollect.push(index);
          }
        }
        for (const index of toCollect) {
          this.freeElement(index);
        }
        // console.log(`collected: ${toCollect}`);
      }
    }

    // console.log(`viewport: scrollTop: ${scrollTop} scrollBottom: ${scrollBottom} viewportMinIndex: ${viewportMinIndex} viewportMaxIndex: ${viewportMaxIndex} alive-count: ${this.elementsDisplayedMap.size} free-count: ${this.elementFreePool.length}`);

    this.viewportMinIndex = viewportMinIndex;
    this.viewportMaxIndex = viewportMaxIndex;
  }

  override render() {
    return html`
<div id="scroll-container" style="height: 500px; overflow: scroll; position: relative; background-color: beige;" @scroll=${this.onScroll}>
  <div id="content-area" style=${styleMap({'height': `${this.rowHeight * this.totalCount}px`})}">
  </div>
</div>
    `;
  }

  protected updated(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    super.updated(changedProperties);
    this.ready();
    this.updateViewport();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'recycler-view': RecyclerView<HTMLElement, object>;
  }
}
