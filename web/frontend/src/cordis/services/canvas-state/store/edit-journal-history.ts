import {
  EDIT_JOURNAL_MAX_BYTES,
  EDIT_JOURNAL_MAX_ENTRIES,
  estimateBytes,
  type JournalEntry
} from "./edit-journal-model.js";

/** Undo/redo history storage and ordering rules, separate from submission queueing. */
export class EditJournalHistory {
  readonly entries: JournalEntry[] = [];
  undoCursor = -1;
  currentBytes = 0;

  reset(): void {
    this.entries.length = 0;
    this.undoCursor = -1;
    this.currentBytes = 0;
  }

  finishUndo(entry: JournalEntry): void {
    const index = this.entries.indexOf(entry);
    if (index < 0 || index > this.undoCursor) return;
    const branched = this.entries.slice(index + 1, this.undoCursor + 1).some(item =>
      entry.undoRevision === undefined || item.revision === undefined || item.revision > entry.undoRevision
    );
    this.entries.splice(index, 1);
    this.undoCursor--;
    if (branched) this.currentBytes -= estimateBytes(entry);
    else this.entries.splice(this.undoCursor + 1, 0, entry);
  }

  finishRedo(entry: JournalEntry, revision: number | undefined): void {
    const index = this.entries.indexOf(entry);
    if (index >= 0) {
      this.entries.splice(index, 1);
      this.currentBytes -= estimateBytes(entry);
      if (index <= this.undoCursor) this.undoCursor--;
    }
    entry.revision = revision;
    entry.undoRevision = undefined;
    if (index < 0) { this.pushCommitted(entry); return; }
    const later = revision === undefined ? -1 : this.entries.findIndex((item, i) =>
      i <= this.undoCursor && item.revision !== undefined && item.revision > revision);
    this.entries.splice(later < 0 ? this.undoCursor + 1 : later, 0, entry);
    this.undoCursor++;
    this.currentBytes += estimateBytes(entry);
    this.enforceCapacity();
  }

  pushCommitted(entry: JournalEntry): void {
    if (entry.revision !== undefined && this.undoCursor + 1 < this.entries.length) {
      const start = this.undoCursor + 1;
      const cut = this.entries.findIndex((item, index) => index >= start
        && (item.undoRevision === undefined || item.undoRevision <= entry.revision!));
      if (cut >= 0) {
        const removed = this.entries.splice(cut);
        for (const item of removed) this.currentBytes -= estimateBytes(item);
      }
      if (start < this.entries.length) {
        const laterApplied = this.entries.findIndex((item, index) => index < start
          && item.revision !== undefined && item.revision > entry.revision!);
        const index = laterApplied < 0 ? start : laterApplied;
        this.entries.splice(index, 0, entry);
        this.currentBytes += estimateBytes(entry);
        this.undoCursor++;
        this.enforceCapacity();
        return;
      }
    }
    if (entry.revision !== undefined) {
      const index = this.entries.findIndex(item => item.revision !== undefined && item.revision > entry.revision!);
      if (index >= 0) {
        this.entries.splice(index, 0, entry);
        this.currentBytes += estimateBytes(entry);
        if (index <= this.undoCursor + 1) this.undoCursor++;
        this.enforceCapacity();
        return;
      }
    }
    if (this.undoCursor + 1 < this.entries.length) {
      const removed = this.entries.splice(this.undoCursor + 1);
      for (const item of removed) this.currentBytes -= estimateBytes(item);
    }
    this.entries.push(entry);
    this.currentBytes += estimateBytes(entry);
    this.undoCursor = this.entries.length - 1;
    this.enforceCapacity();
  }

  enforceCapacity(): void {
    while (this.entries.length > EDIT_JOURNAL_MAX_ENTRIES || this.currentBytes > EDIT_JOURNAL_MAX_BYTES) {
      this.entries.shift();
      this.currentBytes = this.entries.reduce((sum, entry) => sum + estimateBytes(entry), 0);
      this.undoCursor = Math.max(-1, this.undoCursor - 1);
      if (this.entries.length === 0) break;
    }
  }
}
