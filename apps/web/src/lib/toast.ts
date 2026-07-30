export type ToastType = "success" | "error" | "info" | "warning";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

class ToastManager {
  private listeners: ((toast: Toast) => void)[] = [];
  private toasts: Map<string, Toast> = new Map();

  subscribe(listener: (toast: Toast) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  show(message: string, type: ToastType = "info", duration = 5000): string {
    const id = `${Date.now()}-${Math.random()}`;
    const toast: Toast = { id, message, type, duration };

    this.toasts.set(id, toast);
    this.listeners.forEach((l) => l(toast));

    if (duration > 0) {
      setTimeout(() => {
        this.remove(id);
      }, duration);
    }

    return id;
  }

  success(message: string, duration?: number): string {
    return this.show(message, "success", duration);
  }

  error(message: string, duration?: number): string {
    return this.show(message, "error", duration ?? 7000);
  }

  info(message: string, duration?: number): string {
    return this.show(message, "info", duration);
  }

  warning(message: string, duration?: number): string {
    return this.show(message, "warning", duration ?? 6000);
  }

  remove(id: string): void {
    this.toasts.delete(id);
  }

  clear(): void {
    this.toasts.clear();
  }

  getAll(): Toast[] {
    return Array.from(this.toasts.values());
  }
}

export const toastManager = new ToastManager();
