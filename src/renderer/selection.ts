import * as utils from './utils';

export enum SelectionMode {
  SetPrimary,
  Select,
  Add,
  Subtract,
  Toggle,
  SelectToRange,
}

export class Selection<T> {
  private selectFromRangeIndex = 0;
  private selectToRangeIndex = 0;
  private primaryIndex?: number = 0;
  private primaryValue?: T;
  private readonly selectedSet = new Set<number>();

  readonly onSelectionChanged = utils.multicast();

  get primary(): [index?: number, value?: T] {
    return [this.primaryIndex, this.primaryValue];
  }

  select(index: number, value: T|undefined, mode: SelectionMode) {
    this.primaryIndex = index;
    this.primaryValue = value;
    const oldSelectFromRangeIndex = this.selectFromRangeIndex;
    const oldSelectToRangeIndex = this.selectToRangeIndex;
    this.selectFromRangeIndex = index;
    this.selectToRangeIndex = index;
    switch (mode) {
      case SelectionMode.SetPrimary:
        this.selectFromRangeIndex = oldSelectFromRangeIndex;
        this.selectToRangeIndex = oldSelectToRangeIndex;
        break;
      default:
      case SelectionMode.Select:
        this.selectedSet.clear();
        this.selectedSet.add(index);
        break;
      case SelectionMode.Add:
        this.selectedSet.add(index);
        break;
      case SelectionMode.Subtract:
        this.selectedSet.delete(index);
        break;
      case SelectionMode.Toggle:
        if (this.selectedSet.has(index)) {
          this.selectedSet.delete(index);
        } else {
          this.selectedSet.add(index);
        }
        break;
      case SelectionMode.SelectToRange: {
        {
          let a = oldSelectFromRangeIndex;
          let b = oldSelectToRangeIndex;
          let min = Math.min(a, b);
          let max = Math.max(a, b);
          for (let i = min; i <= max; ++i) {
            this.selectedSet.delete(i);
          }
        }
        {
          let a = oldSelectFromRangeIndex;
          let b = index;
          let min = Math.min(a, b);
          let max = Math.max(a, b);
          for (let i = min; i <= max; ++i) {
            this.selectedSet.add(i);
          }
        }
        this.selectFromRangeIndex = oldSelectFromRangeIndex;
        this.selectToRangeIndex = index;
        break;
      }
    }
    this.onSelectionChanged();
  }

  clear() {
    this.selectFromRangeIndex = 0;
    this.primaryIndex = 0;
    this.primaryValue = undefined;
    this.selectedSet.clear();
    this.onSelectionChanged();
  }

  has(index: number) {
    return this.selectedSet.has(index);
  }

  get all(): number[] {
    return Array.from(this.selectedSet);
  }
}
