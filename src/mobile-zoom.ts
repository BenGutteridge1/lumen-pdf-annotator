interface MobileZoomHost {
  isReady(): boolean;
  currentZoom(): number;
  begin(clientX: number, clientY: number): void;
  preview(zoom: number, clientX: number, clientY: number): void;
  commit(zoom: number, clientX: number, clientY: number): void;
  cancel(): void;
}

interface Pinch {
  first: number;
  second: number;
  distance: number;
  initialZoom: number;
  zoom: number;
  x: number;
  y: number;
}

/** Handles only two-finger PDF gestures; one-finger scroll/selection stays native. */
export class MobilePdfZoom {
  private readonly viewWindow: Window;
  private pinch: Pinch | null = null;
  private frame = 0;
  private disposed = false;

  constructor(private readonly viewport: HTMLElement, private readonly host: MobileZoomHost) {
    this.viewWindow = viewport.ownerDocument.defaultView ?? window;
    viewport.addEventListener("touchstart", this.onStart, { passive: false, capture: true });
    viewport.addEventListener("touchmove", this.onMove, { passive: false, capture: true });
    viewport.addEventListener("touchend", this.onEnd, { passive: false, capture: true });
    viewport.addEventListener("touchcancel", this.onCancel, { passive: false, capture: true });
  }

  get active(): boolean { return this.pinch !== null; }

  private consume(event: TouchEvent): boolean {
    if (!event.cancelable) return false;
    event.preventDefault();
    if (!event.defaultPrevented) return false;
    event.stopPropagation();
    return true;
  }

  private readonly onStart = (event: TouchEvent): void => {
    if (this.disposed) return;
    if (this.pinch) {
      if (event.touches.length !== 2) this.cancel();
      else this.consume(event);
      return;
    }
    // Both fingers must start inside this PDF, rather than a toolbar or panel.
    if (event.defaultPrevented || event.touches.length !== 2 || !this.host.isReady()) return;
    // targetTouches contains only fingers that started on the exact same DOM
    // node; real pinches often start on two different spans or saved marks.
    const touches = Array.from(event.touches).filter(touch => this.viewport.contains(touch.target as Node | null));
    if (touches.length !== 2) return;
    const [first, second] = touches;
    const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    const x = (first.clientX + second.clientX) / 2, y = (first.clientY + second.clientY) / 2;
    if (!Number.isFinite(distance) || distance < 2 || !Number.isFinite(x) || !Number.isFinite(y)
      || !this.consume(event)) return;
    const initialZoom = this.host.currentZoom();
    this.pinch = { first: first.identifier, second: second.identifier, distance, initialZoom, zoom: initialZoom, x, y };
    this.host.begin(x, y);
  };

  private readonly onMove = (event: TouchEvent): void => {
    const pinch = this.pinch;
    if (!pinch) return;
    if (event.touches.length !== 2 || !this.host.isReady() || !this.consume(event)) {
      this.cancel();
      return;
    }
    // TouchList order can change as fingers move; identity must not.
    const touches = Array.from(event.touches);
    const first = touches.find(touch => touch.identifier === pinch.first);
    const second = touches.find(touch => touch.identifier === pinch.second);
    if (!first || !second) { this.cancel(); return; }
    const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
    const x = (first.clientX + second.clientX) / 2, y = (first.clientY + second.clientY) / 2;
    if (!Number.isFinite(distance) || !Number.isFinite(x) || !Number.isFinite(y)) { this.cancel(); return; }
    pinch.zoom = Math.max(.25, Math.min(4, pinch.initialZoom * distance / pinch.distance));
    pinch.x = x; pinch.y = y;
    if (!this.frame) this.frame = this.viewWindow.requestAnimationFrame(() => this.preview());
  };

  private preview(): void {
    this.frame = 0;
    const pinch = this.pinch;
    if (!pinch) return;
    if (!this.host.isReady()) { this.cancel(); return; }
    this.host.preview(pinch.zoom, pinch.x, pinch.y);
  }

  private readonly onEnd = (event: TouchEvent): void => {
    if (!this.pinch) return;
    this.consume(event);
    if (event.touches.length >= 2) return;
    if (!this.host.isReady()) { this.cancel(); return; }
    if (this.frame) {
      this.viewWindow.cancelAnimationFrame(this.frame);
      this.preview();
    }
    const pinch = this.pinch;
    if (!pinch || !this.host.isReady()) { this.cancel(); return; }
    this.pinch = null;
    this.host.commit(Math.round(pinch.zoom * 20) / 20, pinch.x, pinch.y);
  };

  private readonly onCancel = (): void => { this.cancel(); };

  cancel(): void {
    this.viewWindow.cancelAnimationFrame(this.frame);
    this.frame = 0;
    const active = this.pinch !== null;
    this.pinch = null;
    if (active) this.host.cancel();
  }

  dispose(): void {
    this.disposed = true;
    this.viewport.removeEventListener("touchstart", this.onStart, true);
    this.viewport.removeEventListener("touchmove", this.onMove, true);
    this.viewport.removeEventListener("touchend", this.onEnd, true);
    this.viewport.removeEventListener("touchcancel", this.onCancel, true);
    this.cancel();
  }
}
