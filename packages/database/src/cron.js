function parsePart(part, min, max) {
    const result = new Set();
    const trimmed = part.trim();
    if (!trimmed || trimmed === "*") {
        for (let i = min; i <= max; i += 1)
            result.add(i);
        return result;
    }
    for (const tokenRaw of trimmed.split(",")) {
        const token = tokenRaw.trim();
        if (!token)
            continue;
        if (token.includes("/")) {
            const [baseRaw, stepRaw] = token.split("/");
            const step = Number.parseInt(stepRaw ?? "", 10);
            if (!Number.isFinite(step) || step <= 0)
                throw new Error(`Invalid cron step '${token}'`);
            const base = (baseRaw ?? "*").trim();
            if (base === "*") {
                for (let i = min; i <= max; i += step)
                    result.add(i);
            }
            else if (base.includes("-")) {
                const [startRaw, endRaw] = base.split("-");
                const start = Number.parseInt(startRaw ?? "", 10);
                const end = Number.parseInt(endRaw ?? "", 10);
                if (!Number.isFinite(start) || !Number.isFinite(end))
                    throw new Error(`Invalid cron range '${token}'`);
                for (let i = start; i <= end; i += step) {
                    if (i >= min && i <= max)
                        result.add(i);
                }
            }
            else {
                const start = Number.parseInt(base, 10);
                if (!Number.isFinite(start))
                    throw new Error(`Invalid cron value '${token}'`);
                for (let i = start; i <= max; i += step) {
                    if (i >= min && i <= max)
                        result.add(i);
                }
            }
            continue;
        }
        if (token.includes("-")) {
            const [startRaw, endRaw] = token.split("-");
            const start = Number.parseInt(startRaw ?? "", 10);
            const end = Number.parseInt(endRaw ?? "", 10);
            if (!Number.isFinite(start) || !Number.isFinite(end))
                throw new Error(`Invalid cron range '${token}'`);
            for (let i = start; i <= end; i += 1) {
                if (i >= min && i <= max)
                    result.add(i);
            }
            continue;
        }
        const value = Number.parseInt(token, 10);
        if (!Number.isFinite(value))
            throw new Error(`Invalid cron value '${token}'`);
        if (value < min || value > max)
            throw new Error(`Cron value '${value}' out of range ${min}-${max}`);
        result.add(value);
    }
    if (result.size === 0)
        throw new Error("Cron field resolved to empty set");
    return result;
}
export function parseCronExpression(expression) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error("Cron expression must have 5 fields: minute hour day month weekday");
    }
    return {
        minutes: parsePart(parts[0] ?? "*", 0, 59),
        hours: parsePart(parts[1] ?? "*", 0, 23),
        dayOfMonth: parsePart(parts[2] ?? "*", 1, 31),
        month: parsePart(parts[3] ?? "*", 1, 12),
        dayOfWeek: parsePart(parts[4] ?? "*", 0, 6),
    };
}
function matches(date, fieldSet) {
    const minute = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const weekDay = date.getDay();
    return (fieldSet.minutes.has(minute) &&
        fieldSet.hours.has(hour) &&
        fieldSet.dayOfMonth.has(day) &&
        fieldSet.month.has(month) &&
        fieldSet.dayOfWeek.has(weekDay));
}
function startOfMinute(date) {
    const next = new Date(date);
    next.setSeconds(0, 0);
    return next;
}
export function computeNextRun(expression, fromDate = new Date()) {
    const fieldSet = parseCronExpression(expression);
    const cursor = startOfMinute(fromDate);
    cursor.setMinutes(cursor.getMinutes() + 1);
    // Search up to one year ahead in minute granularity.
    const maxIterations = 366 * 24 * 60;
    for (let i = 0; i < maxIterations; i += 1) {
        if (matches(cursor, fieldSet)) {
            return new Date(cursor);
        }
        cursor.setMinutes(cursor.getMinutes() + 1);
    }
    throw new Error("No next run found for cron expression in the next 12 months");
}
export function isCronExpressionValid(expression) {
    try {
        parseCronExpression(expression);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=cron.js.map