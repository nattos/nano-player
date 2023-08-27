import {css, html, LitElement, PropertyValueMap} from 'lit';
import {} from 'lit/html';
import {customElement, property, query} from 'lit/decorators.js';
import {styleMap} from 'lit-html/directives/style-map.js';
import {action, observable, makeObservable} from 'mobx';
import * as utils from './utils';
import * as constants from './constants';

export function init() {}

export interface RecyclerViewDataProvider<TElement extends HTMLElement, TData, TGroupElement extends HTMLElement|void = void, TGroupData = void> {
  dataGetter: (index: number) => TData|undefined;
  elementConstructor: () => TElement;
  elementDataSetter: (element: TElement, index: number, data: TData|undefined) => void;

  groupKeyGetter?: (index: number) => string|undefined;
  groupDataGetter?: (index: number) => TGroupData|undefined;
  groupElementConstructor?: () => TGroupElement;
  groupElementDataSetter?: (element: TGroupElement, groupStartIndex: number, groupEndIndex: number, data: TGroupData|undefined) => void;

  insertMarkerConstructor?: () => HTMLElement;
}

@customElement('recycler-view')
export class RecyclerView<TElement extends HTMLElement, TData, TGroupElement extends HTMLElement|void = void, TGroupData = void> extends LitElement {
  @query('#scroll-container') scrollContainer!: HTMLElement;
  @query('#content-area') contentArea!: HTMLElement;
  @query('#group-content-area') groupContentArea!: HTMLElement;
  @query('#markers-area') markersArea!: HTMLElement;

  @property() rowHeight = 42;
  @property() totalCount = 100;
  dataProvider?: RecyclerViewDataProvider<TElement, TData, TGroupElement, TGroupData>;

  elementCollectCountWaterlevel = 16;
  elementsInViewPaddingCount = 16;

  onUserScrolled?: () => void;
  userScrolledUpdateDelay = 100;

  @observable viewportMinIndex = 0;
  @observable viewportMaxIndex = 0;

  private didReady = false;
  private readonly elementsDisplayedMap = new Map<number, TElement>();
  private readonly elementFreePool: TElement[] = [];
  private readonly groupDisplayedList: TGroupElement[] = [];
  private readonly groupFreePool: TGroupElement[] = [];

  private lastProgrammaticScrollTimestamp = 0;
  private isOnScrollInFlight = false;
  private onUserScrolledDirty = false;

  private insertMarkerPosField?: number;
  private insertMarkerElement?: HTMLElement;

  constructor() {
    super();
    makeObservable(this);
  }

  ready() {
    if (this.didReady || !this.contentArea || !this.dataProvider) {
      return;
    }
    this.didReady = true;
  }

  get elementsInView(): TElement[] {
    return Array.from(this.elementsDisplayedMap.values());
  }

  get insertMarkerPos(): number|undefined { return this.insertMarkerPosField; }
  set insertMarkerPos(index: number|undefined) {
    if (this.insertMarkerPosField === index) {
      return;
    }
    this.insertMarkerPosField = index;
    if (index === undefined) {
      this.insertMarkerElement?.remove();
      this.insertMarkerElement = undefined;
    } else {
      if (!this.insertMarkerElement) {
        this.insertMarkerElement = this.dataProvider?.insertMarkerConstructor?.();
        if (!this.insertMarkerElement) {
          return;
        }
      }
      this.markersArea.appendChild(this.insertMarkerElement);
      const element = this.insertMarkerElement;
      element.style['position'] = 'absolute';
      element.style['top'] = `${this.rowHeight * index}px`;
      element.style['width'] = `100%`;
    }
  }

  ensureVisible(center: number, padding: number) {
    let didScroll = false;
    if (this.viewportMinIndex > center) {
      this.scrollContainer.scrollTo({top: (center - padding) * this.rowHeight});
      didScroll = true;
    } else if (this.viewportMaxIndex <= center) {
      this.scrollContainer.scrollTo({top: (center + padding) * this.rowHeight - this.scrollContainer.clientHeight});
      didScroll = true;
    }
    if (didScroll) {
      this.lastProgrammaticScrollTimestamp = Date.now();
    }
  }

  rangeUpdated(min: number, max: number) {
    for (let i = min; i <= max; ++i) {
      const element = this.elementsDisplayedMap.get(i);
      if (element === undefined) {
        continue;
      }
      this.dataProvider?.elementDataSetter(element, i, this.dataProvider?.dataGetter(i));
    }
    this.updateGroups();
  }

  private ensureElement(index: number): TElement|undefined {
    let element = this.elementsDisplayedMap.get(index);
    if (element !== undefined) {
      return element;
    }
    element = this.elementFreePool.pop();
    if (element === undefined) {
      element = this.dataProvider?.elementConstructor();
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

    this.dataProvider?.elementDataSetter(element, index, this.dataProvider?.dataGetter(index));
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
    if (this.isOnScrollInFlight) {
      return;
    }
    this.isOnScrollInFlight = true;
    requestAnimationFrame(() => {
      this.isOnScrollInFlight = false;
      this.updateViewport();
      const timeSinceLastScrollCall = Date.now() - this.lastProgrammaticScrollTimestamp;
      if (timeSinceLastScrollCall > constants.PROGRAMMATIC_SCROLL_DURATION && this.onUserScrolled) {
        if (!this.onUserScrolledDirty) {
          this.onUserScrolledDirty = true;
          setTimeout(() => {
            this.onUserScrolledDirty = false;
            this.onUserScrolled?.();
          }, this.userScrolledUpdateDelay);
        }
      }
    });
  }

  private updateViewport(force = false) {
    const scrollTop = this.scrollContainer!.scrollTop;
    const scrollBottom = scrollTop + this.scrollContainer!.clientHeight;
    const viewportMinIndex = Math.floor(scrollTop / this.rowHeight);
    const viewportMaxIndex = Math.ceil(scrollBottom / this.rowHeight);
    const spawnMinIndex = Math.max(0, Math.min(this.totalCount - 1, viewportMinIndex - this.elementsInViewPaddingCount));
    const spawnMaxIndex = Math.max(0, Math.min(this.totalCount - 1, viewportMaxIndex + this.elementsInViewPaddingCount));

    if (!force) {
      if (this.viewportMinIndex === viewportMinIndex && this.viewportMaxIndex === viewportMaxIndex) {
        return;
      }
    }

    if (this.didReady) {
      for (let i = spawnMinIndex; i < spawnMaxIndex + 1; ++i) {
        this.ensureElement(i);
      }

      const collectWaterlevel = spawnMaxIndex - spawnMinIndex + this.elementCollectCountWaterlevel;
      if (this.elementsDisplayedMap.size > collectWaterlevel) {
        // Sweep elements.
        const toCollect = [];
        for (const [index, value] of this.elementsDisplayedMap) {
          if (index < spawnMinIndex || index > spawnMaxIndex) {
            toCollect.push(index);
          }
        }
        for (const index of toCollect) {
          this.freeElement(index);
        }
        // console.log(`collected: ${toCollect}`);
      }
      this.updateGroups();
    }

    // console.log(`viewport: scrollTop: ${scrollTop} scrollBottom: ${scrollBottom} viewportMinIndex: ${viewportMinIndex} viewportMaxIndex: ${viewportMaxIndex} alive-count: ${this.elementsDisplayedMap.size} free-count: ${this.elementFreePool.length}`);

    this.viewportMinIndex = viewportMinIndex;
    this.viewportMaxIndex = viewportMaxIndex;
  }

  private updateGroups() {
    const scrollTop = this.scrollContainer!.scrollTop;
    const scrollBottom = scrollTop + this.scrollContainer!.clientHeight;
    const viewportMinIndex = Math.floor(scrollTop / this.rowHeight);
    const viewportMaxIndex = Math.ceil(scrollBottom / this.rowHeight);
    const spawnMinIndex = Math.max(0, Math.min(this.totalCount - 1, viewportMinIndex - this.elementsInViewPaddingCount));
    const spawnMaxIndex = Math.max(0, Math.min(this.totalCount - 1, viewportMaxIndex + this.elementsInViewPaddingCount));

    if (this.didReady) {
      let nextGroupElementIndex = 0;
      let groupStartIndex = spawnMinIndex;
      let groupKey: string|undefined = undefined;
      const maybeFinishGroup = (index: number, force = false) => {
        if (!this.dataProvider?.groupKeyGetter || !this.dataProvider?.groupElementConstructor) {
          return;
        }
        const nextGroupKey = this.dataProvider.groupKeyGetter(index);
        if (groupKey !== nextGroupKey || force) {
          const groupEndIndex = index - 1;
          if (groupEndIndex >= groupStartIndex) {
            // Create this group.
            // console.log(`group from {${groupStartIndex} - ${groupEndIndex}} for ${groupKey}`);

            let groupElement: TGroupElement|undefined;
            if (nextGroupElementIndex < this.groupDisplayedList.length) {
              groupElement = this.groupDisplayedList[nextGroupElementIndex];
            }
            if (groupElement === undefined) {
              groupElement = this.groupFreePool.pop() ?? this.dataProvider.groupElementConstructor();
              const htmlElement = utils.nonvoid<HTMLElement>(groupElement);
              if (groupElement !== undefined && htmlElement !== undefined) {
                this.groupContentArea.appendChild(htmlElement);
                this.groupDisplayedList.push(groupElement);
              }
            }
            if (groupElement) {
              const groupData = this.dataProvider.groupDataGetter?.(groupStartIndex);
              this.dataProvider.groupElementDataSetter?.(groupElement, groupStartIndex, groupEndIndex, groupData);

              const groupRowCount = groupEndIndex - groupStartIndex + 1;
              groupElement.style['position'] = 'absolute';
              groupElement.style['height'] = `${this.rowHeight * groupRowCount}px`;
              groupElement.style['top'] = `${this.rowHeight * groupStartIndex}px`;
              groupElement.style['width'] = `100%`;
            }
            nextGroupElementIndex++;
          }

          // Advance group.
          groupStartIndex = index;
          groupKey = nextGroupKey;
        }
      }

      for (let i = spawnMinIndex; i < spawnMaxIndex + 1; ++i) {
        maybeFinishGroup(i);
      }
      maybeFinishGroup(spawnMaxIndex, true);
      if (nextGroupElementIndex < this.groupDisplayedList.length) {
        const toRemove = this.groupDisplayedList.splice(nextGroupElementIndex);
        for (const groupElement of toRemove) {
          utils.nonvoid<HTMLElement>(groupElement)?.remove();
        }
        this.groupFreePool.push(...toRemove);
      }
    }
  }

  static styles = css`
    .scroll-container {
      height: 100%;
      overflow: scroll;
      position: relative;
    }

    .content-area {
    }

    .group-content-area {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      pointer-events: none;
    }

    .markers-area {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      pointer-events: none;
    }
  `;

  override render() {
    return html`
<div id="scroll-container" class="scroll-container" @scroll=${this.onScroll}>
  <div id="content-area" class="content-area" style=${styleMap({'height': `${this.rowHeight * this.totalCount}px`})}">
  </div>
  <div id="group-content-area" class="group-content-area" style=${styleMap({'height': `${this.rowHeight * this.totalCount}px`})}">
  </div>
  <div id="markers-area" class="markers-area" style=${styleMap({'height': `${this.rowHeight * this.totalCount}px`})}">
  </div>
</div>
    `;
  }

  protected updated(changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>): void {
    super.updated(changedProperties);
    this.ready();
    this.updateViewport(true);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'recycler-view': RecyclerView<HTMLElement, object>;
  }
}
