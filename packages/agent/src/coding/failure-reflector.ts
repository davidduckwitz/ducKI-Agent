import type { LLMProvider } from "@ducki/providers";
import type { Logger } from "@ducki/logger";
import type { LLMMessage } from "@ducki/shared";
import type { RunJournalEntry } from "../config/interfaces_types.js";
import type { CodingFailureReflection } from "./coding-run-state.js";

const DEFAULT_FAILURE_REFLECTION_TIMEOUT_MS = 15_000;
const MAX_ERROR_CHARS = 3500;
const MAX_SUMMARY_CHARS = 1800;
const MAX_JOURNAL_ENTRIES = 8;
const MAX_EDIT_DIFFS = 5;
const MAX_DIFF_CHARS = 600;

/** One filesystem write/edit/append made during the failing attempt, so the reflector can see
 *  WHAT actually changed instead of guessing from a one-line journal summary like "edit a.ts". */
export interface CodingFailureEditDiff {
  path: string;
  /** "write" | "edit" | "append" - the filesystem action that produced this diff. */
  action: string;
  /** Removed text for an "edit" action; absent for write/append (nothing to remove). */
  before?: string;
  /** Inserted/written text. */
  after: string;
}

export interface CodingFailureReflectionInput {
  goal: string;
  verifyCommand: string;
  verifyError: string;
  previousSummary: string;
  journal: RunJournalEntry[];
  /** Edits made during the attempt that just failed - the direct evidence of what was tried. */
  recentEdits?: CodingFailureEditDiff[];
  /**
   * "avoid" hints from EARLIER reflections this run, so a repeat reflection doesn't re-suggest an
   * approach a prior diagnosis already ruled out - without this, two reflections spaced a few
   * attempts apart have no memory of each other and can send the model back and forth between the
   * same two wrong fixes.
   */
  previouslyRuledOut?: string[];
}

function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[…truncated…]`;
}

function normalizeStringList(value: unknown, maxItems = 4): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, maxItems);
}

/**
 * One bounded, failure-only diagnostic pass for CodingAgent.
 *
 * This is deliberately NOT the generic response Reflection system. It never rewrites successful
 * output and never runs on the happy path. CodingAgent calls it only after the verifier produced
 * the exact same failure for a second attempt, where the existing "try again" loop has concrete
 * evidence that the previous edit did not change the outcome. The result is a tiny structured
 * diagnosis injected into the NEXT attempt, not executable instructions and not a second agent.
 *
 * The pass is capped by both tokens and wall-clock time. Any timeout, provider error or malformed
 * JSON degrades to `undefined`; the existing deterministic verify-feedback path continues exactly
 * as before. The timeout also aborts the provider request itself, so a discarded reflection cannot
 * keep consuming remote/local inference resources after the coding run has already moved on.
 */
export class CodingFailureReflector {
  constructor(
    private readonly provider: LLMProvider,
    private readonly logger: Logger,
    private readonly timeoutMs = DEFAULT_FAILURE_REFLECTION_TIMEOUT_MS
  ) {}

  async reflect(input: CodingFailureReflectionInput): Promise<CodingFailureReflection | undefined> {
    const recentJournal = input.journal.slice(-MAX_JOURNAL_ENTRIES).map((entry) => {
      const error = entry.errorDetail ? ` | error=${clamp(entry.errorDetail, 250)}` : "";
      return `- ${entry.toolName}: ${entry.success ? "ok" : "failed"} | ${entry.summary}${error}`;
    });

    const recentEdits = (input.recentEdits ?? []).slice(-MAX_EDIT_DIFFS).map((edit) => {
      const parts = [`--- ${edit.action} ${edit.path} ---`];
      if (edit.before) parts.push(`removed:\n${clamp(edit.before, MAX_DIFF_CHARS)}`);
      parts.push(`${edit.before ? "inserted" : "content"}:\n${clamp(edit.after, MAX_DIFF_CHARS)}`);
      return parts.join("\n");
    });

    const ruledOut = (input.previouslyRuledOut ?? []).filter((entry, i, arr) => arr.indexOf(entry) === i);

    const messages: LLMMessage[] = [
      {
        role: "system",
        content: [
          "You diagnose a coding-agent retry that failed deterministic verification twice with the SAME error.",
          "Return ONLY a compact JSON object with this exact shape:",
          '{"diagnosis":"one grounded root-cause hypothesis","avoid":["approach not to repeat"],"nextActions":["specific next check or change"]}',
          "Rules:",
          "- Base the diagnosis ONLY on the supplied verifier error, edit diffs, prior attempt summary and tool journal.",
          "- Do not invent file contents, APIs, commands or facts that are not present.",
          "- Focus on why the previous change had no effect on THIS verifier error.",
          "- If edit diffs are provided, reason about them directly - e.g. whether the edited file is even the one the error points at.",
          "- Do not repeat any approach listed under 'Already ruled out' - propose something genuinely different.",
          "- Prefer 1-3 concrete next actions; no prose outside JSON; no code fences; no chain-of-thought.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Goal: ${clamp(input.goal, 1200)}`,
          `Verification command: ${input.verifyCommand}`,
          "Verification error (same on two consecutive attempts):",
          clamp(input.verifyError, MAX_ERROR_CHARS),
          "Previous attempt summary:",
          clamp(input.previousSummary, MAX_SUMMARY_CHARS),
          recentEdits.length > 0
            ? `Edits made in the failing attempt:\n${recentEdits.join("\n\n")}`
            : "Edits made in the failing attempt: (none captured)",
          recentJournal.length > 0 ? `Recent tool journal:\n${recentJournal.join("\n")}` : "Recent tool journal: (empty)",
          ruledOut.length > 0
            ? `Already ruled out by earlier reflections this run (do NOT repeat):\n${ruledOut.map((a) => `- ${a}`).join("\n")}`
            : "Already ruled out by earlier reflections this run: (none yet)",
        ].join("\n\n"),
      },
    ];

    const abortController = new AbortController();
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(new Error(`failure reflection timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });
      const response = await Promise.race([
        this.provider.generate(messages, {
          temperature: 0.1,
          maxTokens: 500,
          signal: abortController.signal,
        }),
        timeout,
      ]);
      const parsed = this.parse(response.content);
      if (!parsed) {
        this.logger.debug("Coding failure reflection returned no parseable JSON");
        return undefined;
      }
      return parsed;
    } catch (error) {
      this.logger.warn("Coding failure reflection skipped", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  private parse(content: string): CodingFailureReflection | undefined {
    const candidates: string[] = [content.trim()];
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) candidates.push(fenced[1].trim());
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(content.slice(start, end + 1));

    for (const candidate of candidates) {
      try {
        const raw = JSON.parse(candidate) as Record<string, unknown>;
        const diagnosis = typeof raw["diagnosis"] === "string" ? raw["diagnosis"].trim() : "";
        if (!diagnosis) continue;
        return {
          diagnosis: clamp(diagnosis, 800),
          avoid: normalizeStringList(raw["avoid"]),
          nextActions: normalizeStringList(raw["nextActions"]),
        };
      } catch {
        // Try the next extraction strategy.
      }
    }
    return undefined;
  }
}
