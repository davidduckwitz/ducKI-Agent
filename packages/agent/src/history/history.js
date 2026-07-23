export class History {
    entries = [];
    maxEntries;
    constructor(maxEntries = 1000) {
        this.maxEntries = maxEntries;
    }
    add(message, toolName) {
        this.entries.push({
            timestamp: new Date().toISOString(),
            role: message.role,
            content: message.content,
            toolName,
        });
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(-this.maxEntries);
        }
    }
    getAll() {
        return [...this.entries];
    }
    getLast(count) {
        return this.entries.slice(-count);
    }
    getByRole(role) {
        return this.entries.filter((e) => e.role === role);
    }
    clear() {
        this.entries = [];
    }
    get length() {
        return this.entries.length;
    }
    toMessages() {
        return this.entries.map((e) => ({
            role: e.role,
            content: e.content,
        }));
    }
}
//# sourceMappingURL=history.js.map