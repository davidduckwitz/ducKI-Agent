export interface CronFieldSet {
    minutes: Set<number>;
    hours: Set<number>;
    dayOfMonth: Set<number>;
    month: Set<number>;
    dayOfWeek: Set<number>;
}
export declare function parseCronExpression(expression: string): CronFieldSet;
export declare function computeNextRun(expression: string, fromDate?: Date): Date;
export declare function isCronExpressionValid(expression: string): boolean;
//# sourceMappingURL=cron.d.ts.map