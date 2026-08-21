export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

/** How long a notification stays on screen before it disappears on its own. */
export const DEFAULT_TOAST_DURATION = 5000;

class ToastManager {
  private listeners: ((toast: Toast) => void)[] = [];
  private dismissListeners: ((id: string) => void)[] = [];
  private toasts: Map<string, Toast> = new Map();
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  subscribe(listener: (toast: Toast) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Notifies when a toast expires or is dismissed.
   *
   * Without this the auto-dismiss never reached the screen: the timer removed the toast from
   * this manager's map, but the map is not what the UI renders - the display keeps its own
   * list built from `subscribe`. Toasts therefore piled up in the corner until each one was
   * clicked away by hand.
   */
  subscribeDismiss(listener: (id: string) => void): () => void {
    this.dismissListeners.push(listener);
    return () => {
      this.dismissListeners = this.dismissListeners.filter((l) => l !== listener);
    };
  }

  /** `duration <= 0` keeps the toast until it is dismissed explicitly. */
  show(message: string, type: ToastType = "info", duration = DEFAULT_TOAST_DURATION): string {
    const id = `${Date.now()}-${Math.random()}`;
    const toast: Toast = { id, message, type, duration };

    this.toasts.set(id, toast);
    this.listeners.forEach((l) => l(toast));

    if (duration > 0) {
      this.timers.set(
        id,
        setTimeout(() => {
          this.remove(id);
        }, duration)
      );
    }

    return id;
  }

  success(message: string, duration?: number): string {
    return this.show(message, "success", duration);
  }

  error(message: string, duration?: number): string {
    return this.show(message, "error", duration);
  }

  info(message: string, duration?: number): string {
    return this.show(message, "info", duration);
  }

  warning(message: string, duration?: number): string {
    return this.show(message, "warning", duration);
  }

  remove(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts.delete(id);
    this.dismissListeners.forEach((l) => l(id));
  }

  clear(): void {
    for (const id of [...this.toasts.keys()]) {
      this.remove(id);
    }
  }

  getAll(): Toast[] {
    return Array.from(this.toasts.values());
  }
}

export const toastManager = new ToastManager();
