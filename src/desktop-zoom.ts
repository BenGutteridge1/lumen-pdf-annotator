interface DesktopZoomHost {
  isReady(): boolean;
  currentZoom(): number;
  begin(): void;
  preview(zoom: number, clientX: number, clientY: number): void;
  commit(zoom: number, clientX: number, clientY: number): void;
  cancel(): void;
}

const GESTURE_IDLE_MS = 160;
const MAX_EVENT_DELTA = 25;

/** A viewport-local Chromium trackpad pinch / Ctrl+wheel gesture. */
export class DesktopPdfZoom {
  private readonly viewWindow: Window;
  private frame = 0;
  private timer = 0;
  private pendingZoom: number | null = null;
  private clientX = 0;
  private clientY = 0;
  private disposed = false;

  constructor(private readonly viewport: HTMLElement, private readonly host: DesktopZoomHost) {
    this.viewWindow = viewport.ownerDocument.defaultView ?? window;
    // Chromium offers touchpad pinch as a cancelable ctrlKey wheel before
    // applying native visual zoom. No application/Electron zoom limits change.
    viewport.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.disposed || event.defaultPrevented || !event.cancelable
      || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
      || !Number.isFinite(event.deltaY) || event.deltaY === 0
      || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    if (!this.host.isReady()) return;
    const unit = event.deltaMode === 0 ? 1 : event.deltaMode === 1 ? 16
      : event.deltaMode === 2 ? this.viewport.clientHeight : 0;
    if (!unit) return;
    event.preventDefault();
    if (!event.defaultPrevented) return;
    event.stopPropagation();
    const delta = Math.max(-MAX_EVENT_DELTA, Math.min(MAX_EVENT_DELTA, event.deltaY * unit));
    const current = this.pendingZoom ?? this.host.currentZoom();
    const target = Math.max(.5, Math.min(4, current * Math.exp(-delta / 100)));
    if (this.pendingZoom === null && target === current) return;
    if (this.pendingZoom === null) this.host.begin();
    this.pendingZoom = target;
    this.clientX = event.clientX;
    this.clientY = event.clientY;
    if (!this.frame) this.frame = this.viewWindow.requestAnimationFrame(() => this.preview());
    this.viewWindow.clearTimeout(this.timer);
    this.timer = this.viewWindow.setTimeout(() => this.finish(), GESTURE_IDLE_MS);
  };

  private preview(): void {
    this.frame = 0;
    if (this.pendingZoom === null) return;
    if (!this.host.isReady()) {
      this.cancel();
      return;
    }
    this.host.preview(this.pendingZoom, this.clientX, this.clientY);
  }

  private finish(): void {
    this.timer = 0;
    if (this.pendingZoom === null) return;
    if (!this.host.isReady()) {
      this.cancel();
      return;
    }
    if (this.frame) {
      this.viewWindow.cancelAnimationFrame(this.frame);
      this.preview();
    }
    if (this.pendingZoom === null || !this.host.isReady()) {
      this.cancel();
      return;
    }
    const zoom = Math.round(this.pendingZoom * 100) / 100;
    this.pendingZoom = null;
    this.host.commit(zoom, this.clientX, this.clientY);
  }

  cancel(): void {
    this.viewWindow.cancelAnimationFrame(this.frame);
    this.viewWindow.clearTimeout(this.timer);
    this.frame = 0;
    this.timer = 0;
    if (this.pendingZoom !== null) this.host.cancel();
    this.pendingZoom = null;
  }

  dispose(): void {
    this.disposed = true;
    this.viewport.removeEventListener("wheel", this.onWheel);
    this.cancel();
  }
}
