import { truncateText } from "./privacy.js";
import type { CronJobRecord, CronSchedule, CronWeekday } from "./types.js";

const CHINESE_DIGIT_MAP: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const WEEKDAY_TO_INDEX: Record<CronWeekday, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const INDEX_TO_WEEKDAY: Record<number, CronWeekday> = {
  0: "SUN",
  1: "MON",
  2: "TUE",
  3: "WED",
  4: "THU",
  5: "FRI",
  6: "SAT",
};

const WEEKDAY_LABEL: Record<CronWeekday, string> = {
  MON: "周一",
  TUE: "周二",
  WED: "周三",
  THU: "周四",
  FRI: "周五",
  SAT: "周六",
  SUN: "周日",
};

function parseChineseNumber(input: string): number | null {
  const text = input.trim();
  if (!text) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }

  if (text === "十") {
    return 10;
  }

  const tensMatch = text.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (tensMatch) {
    const tens = tensMatch[1] ? (CHINESE_DIGIT_MAP[tensMatch[1]] ?? 0) : 1;
    const ones = tensMatch[2] ? (CHINESE_DIGIT_MAP[tensMatch[2]] ?? 0) : 0;
    return tens * 10 + ones;
  }

  if (text.length === 1 && text in CHINESE_DIGIT_MAP) {
    return CHINESE_DIGIT_MAP[text];
  }

  return null;
}

function sortWeekdays(weekdays: CronWeekday[]): CronWeekday[] {
  const unique = [...new Set(weekdays)];
  return unique.sort(
    (left, right) => WEEKDAY_TO_INDEX[left] - WEEKDAY_TO_INDEX[right],
  );
}

function primaryTimeOfDay(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function normalizeDailyTime(input: string): string | null {
  const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function buildDailySchedule(time: string): CronSchedule | null {
  const normalized = normalizeDailyTime(time);
  if (!normalized) {
    return null;
  }

  return { kind: "daily", time: normalized };
}

export function buildWeeklySchedule(
  weekdays: CronWeekday[],
  time: string,
): CronSchedule | null {
  const normalized = normalizeDailyTime(time);
  const normalizedWeekdays = sortWeekdays(weekdays);
  if (!normalized || normalizedWeekdays.length === 0) {
    return null;
  }

  return {
    kind: "weekly",
    weekdays: normalizedWeekdays,
    time: normalized,
  };
}

export function buildHourlySchedule(
  intervalHours: number,
  anchorIso: string,
): CronSchedule | null {
  if (
    !Number.isInteger(intervalHours) ||
    intervalHours < 1 ||
    intervalHours > 24 ||
    Number.isNaN(new Date(anchorIso).getTime())
  ) {
    return null;
  }

  return {
    kind: "hourly",
    intervalHours,
    anchorIso,
  };
}

export function describeCronSchedule(schedule: CronSchedule): string {
  if (schedule.kind === "daily") {
    return `每天 ${schedule.time}`;
  }

  if (schedule.kind === "weekly") {
    const weekdayLabel = schedule.weekdays
      .map((weekday) => WEEKDAY_LABEL[weekday])
      .join("、");
    return `每周 ${weekdayLabel} ${schedule.time}`;
  }

  return `每隔 ${schedule.intervalHours} 小时`;
}

export function getPrimaryScheduleTime(schedule: CronSchedule): string {
  if (schedule.kind === "hourly") {
    return primaryTimeOfDay(schedule.anchorIso);
  }

  return schedule.time;
}

export function serializeCronSchedule(schedule: CronSchedule): {
  scheduleKind: CronJobRecord["scheduleKind"];
  scheduleConfigJson: string;
  scheduleLabel: string;
  scheduleTime: string;
} {
  return {
    scheduleKind: schedule.kind,
    scheduleConfigJson: JSON.stringify(schedule),
    scheduleLabel: describeCronSchedule(schedule),
    scheduleTime: getPrimaryScheduleTime(schedule),
  };
}

export function hydrateCronSchedule(
  job: Pick<CronJobRecord, "scheduleKind" | "scheduleConfigJson" | "scheduleTime">,
): CronSchedule {
  if (job.scheduleConfigJson) {
    try {
      const parsed = JSON.parse(job.scheduleConfigJson) as Partial<CronSchedule>;
      if (
        parsed.kind === "daily" &&
        typeof parsed.time === "string" &&
        normalizeDailyTime(parsed.time)
      ) {
        return { kind: "daily", time: normalizeDailyTime(parsed.time)! };
      }

      if (
        parsed.kind === "weekly" &&
        typeof parsed.time === "string" &&
        Array.isArray(parsed.weekdays)
      ) {
        const weekdays = parsed.weekdays.filter((item): item is CronWeekday =>
          ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].includes(String(item)),
        );
        const schedule = buildWeeklySchedule(weekdays, parsed.time);
        if (schedule) {
          return schedule;
        }
      }

      if (
        parsed.kind === "hourly" &&
        typeof parsed.intervalHours === "number" &&
        typeof parsed.anchorIso === "string"
      ) {
        const schedule = buildHourlySchedule(parsed.intervalHours, parsed.anchorIso);
        if (schedule) {
          return schedule;
        }
      }
    } catch {
      // Fall back to legacy fields below.
    }
  }

  return buildDailySchedule(job.scheduleTime) ?? { kind: "daily", time: "09:00" };
}

export function looksLikeNaturalCronIntent(input: string): boolean {
  const text = input.trim();
  return /(?:每天|每日|每周|每星期|星期|周[一二三四五六日天]|礼拜|工作日|每隔|每\d+小时|每[一二两三四五六七八九十\d]+小时|定时|提醒|计划任务|cron|到点)/i.test(
    text,
  );
}

export function parseNaturalLanguageCron(
  input: string,
): { schedule: CronSchedule; prompt: string } | null {
  const text = input.trim().replace(/\s+/g, "");

  const exact = text.match(
    /^每天(?:(早上|上午|中午|下午|晚上|凌晨))?([零一二两三四五六七八九十\d]{1,3})点(?:(半)|([零一二两三四五六七八九十\d]{1,3})分?)?(.*)$/i,
  );
  if (!exact) {
    return null;
  }

  const period = exact[1] ?? "";
  const hour = parseChineseNumber(exact[2]);
  const minute =
    exact[3] === "半"
      ? 30
      : exact[4]
        ? parseChineseNumber(exact[4])
        : 0;
  const prompt = exact[5]?.trim() ?? "";

  if (hour === null || minute === null || prompt.length === 0) {
    return null;
  }

  let normalizedHour = hour;
  if ((period === "下午" || period === "晚上") && normalizedHour < 12) {
    normalizedHour += 12;
  } else if (period === "凌晨" && normalizedHour === 12) {
    normalizedHour = 0;
  } else if (period === "中午" && normalizedHour < 11) {
    normalizedHour += 12;
  }

  const schedule = buildDailySchedule(
    `${String(normalizedHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  );
  if (!schedule) {
    return null;
  }

  return {
    schedule,
    prompt,
  };
}

export function computeNextDailyRunIso(
  scheduleTime: string,
  now = new Date(),
): string {
  const normalized = normalizeDailyTime(scheduleTime);
  if (!normalized) {
    throw new Error(`Invalid schedule time: ${scheduleTime}`);
  }

  const [hourText, minuteText] = normalized.split(":");
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  candidate.setHours(Number.parseInt(hourText, 10), Number.parseInt(minuteText, 10), 0, 0);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate.toISOString();
}

function computeNextWeeklyRunIso(
  schedule: Extract<CronSchedule, { kind: "weekly" }>,
  now = new Date(),
): string {
  const [hourText, minuteText] = schedule.time.split(":");
  const targetHour = Number.parseInt(hourText, 10);
  const targetMinute = Number.parseInt(minuteText, 10);
  let bestCandidate: Date | null = null;

  for (let offset = 0; offset <= 13; offset += 1) {
    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(targetHour, targetMinute, 0, 0);
    const weekday = INDEX_TO_WEEKDAY[candidate.getDay()];
    if (!schedule.weekdays.includes(weekday)) {
      continue;
    }
    if (candidate.getTime() <= now.getTime()) {
      continue;
    }
    if (!bestCandidate || candidate.getTime() < bestCandidate.getTime()) {
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    throw new Error(`Could not compute next weekly run for ${schedule.time}`);
  }

  return bestCandidate.toISOString();
}

function computeNextHourlyRunIso(
  schedule: Extract<CronSchedule, { kind: "hourly" }>,
  now = new Date(),
): string {
  const anchor = new Date(schedule.anchorIso);
  const intervalMs = schedule.intervalHours * 60 * 60 * 1000;
  let nextTime = anchor.getTime();
  const nowTime = now.getTime();

  if (nextTime <= nowTime) {
    const elapsed = nowTime - nextTime;
    const steps = Math.floor(elapsed / intervalMs) + 1;
    nextTime += steps * intervalMs;
  }

  return new Date(nextTime).toISOString();
}

export function computeNextRunIso(
  schedule: CronSchedule,
  now = new Date(),
): string {
  if (schedule.kind === "daily") {
    return computeNextDailyRunIso(schedule.time, now);
  }

  if (schedule.kind === "weekly") {
    return computeNextWeeklyRunIso(schedule, now);
  }

  return computeNextHourlyRunIso(schedule, now);
}

export function computeRetryRunIso(
  retryBaseMinutes: number,
  retryAttempt: number,
  now = new Date(),
): string {
  const multiplier = Math.max(0, retryAttempt - 1);
  const delayMinutes = retryBaseMinutes * 2 ** multiplier;
  return new Date(now.getTime() + delayMinutes * 60_000).toISOString();
}

export function formatLocalDateTime(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function buildCronJobName(prompt: string): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  return truncateText(compact || "定时任务", 24);
}
