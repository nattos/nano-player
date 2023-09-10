
export class PointerDragOp {
  private isDisposed = false;
  private readonly pointerId;
  private readonly moveFunc;
  private readonly upFunc;
  private readonly cancelFunc;

  constructor(e: PointerEvent, private readonly element: HTMLElement, readonly callbacks: {
      move?: (e: PointerEvent) => void,
      accept?: (e: PointerEvent) => void,
      cancel?: () => void,
      complete?: () => void,
      callMoveImmediately?: boolean,
      callMoveBeforeDone?: boolean,
    }) {
    this.pointerId = e.pointerId;
    element.setPointerCapture(this.pointerId);
    e.preventDefault()
  
    this.moveFunc = this.onPointerMove.bind(this);
    this.upFunc = this.onPointerUp.bind(this);
    this.cancelFunc = this.onPointerCancel.bind(this);
    window.addEventListener('pointermove', this.moveFunc);
    window.addEventListener('pointerup', this.upFunc);
    window.addEventListener('pointercancel', this.cancelFunc);
    if (this.callbacks.callMoveImmediately) {
      this.moveFunc(e);
    }
  }

  private onPointerMove(e: PointerEvent) {
    if (this.isDisposed || e.pointerId !== this.pointerId) {
      return;
    }
    this.callbacks?.move?.(e);
  }

  private onPointerUp(e: PointerEvent) {
    if (this.isDisposed || e.pointerId !== this.pointerId) {
      return;
    }
    if (this.callbacks.callMoveBeforeDone) {
      this.callbacks?.move?.(e);
    }
    this.callbacks?.accept?.(e);
    this.callbacks?.complete?.();
    this.finishDispose();
  }

  private onPointerCancel(e: PointerEvent) {
    if (this.isDisposed || e.pointerId !== this.pointerId) {
      return;
    }
    if (this.callbacks.callMoveBeforeDone) {
      this.callbacks?.move?.(e);
    }
    this.callbacks?.cancel?.();
    this.callbacks?.complete?.();
    this.finishDispose();
  }

  dispose() {
    if (this.isDisposed) {
      return;
    }
    this.callbacks?.cancel?.();
    this.callbacks?.complete?.();
    this.finishDispose();
  }

  private finishDispose() {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;

    this.element.releasePointerCapture(this.pointerId);
    window.removeEventListener('pointermove', this.moveFunc);
    window.removeEventListener('pointerup', this.upFunc);
    window.removeEventListener('pointercancel', this.cancelFunc);
  }
}
