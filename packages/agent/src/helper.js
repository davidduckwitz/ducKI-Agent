"use strict";
const isProviderLoadError = (message) => {
    const normalized = message.toLowerCase();
    return normalized.includes("402")
        || normalized.includes("provider returned error")
        || normalized.includes("payment")
        || normalized.includes("quota")
        || normalized.includes("context")
        || normalized.includes("too large")
        || normalized.includes("token");
};
const isContextOverflowError = (message) => {
    const normalized = message.toLowerCase();
    return normalized.includes("maximum context length")
        || normalized.includes("max context")
        || normalized.includes("requested about")
        || normalized.includes("too many tokens")
        || normalized.includes("context length");
};
//# sourceMappingURL=helper.js.map