import * as pdfjsLib from 'pdfjs-dist';

// Centralized PDF.js worker configuration
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
}

export type RenderPriority = 0 | 1; // 0 = thumbnail (low), 1 = viewport page (high)

interface QueuedTask {
  id: string;
  priority: RenderPriority;
  execute: () => Promise<void>;
  cancel: () => void;
  aborted: boolean;
}

class PDFRenderScheduler {
  private queue: QueuedTask[] = [];
  private activeLowPriority = 0;
  private activeHighPriority = 0;
  private maxLowPriority = 2; // At most 2 concurrent thumbnail renders
  private maxHighPriority = 2; // At most 2 concurrent viewport renders
  private activeTasks = new Map<string, QueuedTask>();
  private processScheduled = false;

  /**
   * Schedules a PDF rendering task.
   * High priority tasks (main viewport) are placed before low priority tasks.
   * Returns a cleanup function to cancel the task.
   */
  schedule(
    id: string,
    priority: RenderPriority,
    execute: () => Promise<void>,
    cancel: () => void
  ): () => void {
    // If a task with this ID is already queued or running, cancel it first
    this.cancel(id);

    const task: QueuedTask = {
      id,
      priority,
      execute,
      cancel,
      aborted: false,
    };

    if (priority === 1) {
      // Place high-priority tasks at the front of the queue
      const insertIdx = this.queue.findIndex((t) => t.priority === 0);
      if (insertIdx === -1) {
        this.queue.push(task);
      } else {
        this.queue.splice(insertIdx, 0, task);
      }
    } else {
      this.queue.push(task);
    }

    this.scheduleProcessQueue();

    return () => {
      this.cancel(id);
    };
  }

  /**
   * Cancel all queued and active tasks (e.g. on unmount).
   */
  clear(): void {
    while (this.queue.length > 0) {
      const task = this.queue.pop();
      if (task) {
        task.aborted = true;
        task.cancel();
      }
    }
    for (const task of this.activeTasks.values()) {
      task.aborted = true;
      task.cancel();
    }
    this.activeTasks.clear();
    this.activeHighPriority = 0;
    this.activeLowPriority = 0;
  }

  /**
   * Cancel an in-flight or queued task by ID.
   */
  cancel(id: string): void {
    // Check queued
    const qIdx = this.queue.findIndex((t) => t.id === id);
    if (qIdx !== -1) {
      const [task] = this.queue.splice(qIdx, 1);
      task.aborted = true;
      task.cancel();
      return;
    }

    // Check active
    const active = this.activeTasks.get(id);
    if (active) {
      active.aborted = true;
      active.cancel();
    }
  }


  private scheduleProcessQueue(): void {
    if (this.processScheduled) return;
    this.processScheduled = true;
    queueMicrotask(() => {
      this.processScheduled = false;
      this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.queue.length === 0) return;

    // Check if we can run next task
    const nextIdx = this.queue.findIndex((task) => {
      if (task.priority === 1 && this.activeHighPriority < this.maxHighPriority) {
        return true;
      }
      if (task.priority === 0 && this.activeLowPriority < this.maxLowPriority) {
        return true;
      }
      return false;
    });

    if (nextIdx === -1) return;

    const [task] = this.queue.splice(nextIdx, 1);
    if (task.aborted) {
      this.scheduleProcessQueue();
      return;
    }

    if (task.priority === 1) {
      this.activeHighPriority++;
    } else {
      this.activeLowPriority++;
    }
    this.activeTasks.set(task.id, task);

    task
      .execute()
      .catch((err) => {
        if (err?.name !== 'RenderingCancelledException' && !task.aborted) {
          console.warn(`PDFRenderScheduler task ${task.id} error:`, err);
        }
      })
      .finally(() => {
        if (task.priority === 1) {
          this.activeHighPriority--;
        } else {
          this.activeLowPriority--;
        }
        this.activeTasks.delete(task.id);
        // Process next queued items
        this.scheduleProcessQueue();
      });

    // Try starting another task if capacity remains
    this.scheduleProcessQueue();
  }
}

export const pdfScheduler = new PDFRenderScheduler();

