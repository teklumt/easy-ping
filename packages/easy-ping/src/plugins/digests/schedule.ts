export type DigestWindow = "daily" | "weekly";

export type LocalMoment = {
  /** YYYY-MM-DD in the recipient's zone. */
  date: string;
  hour: number;
  /** 0 = Sunday. */
  weekday: number;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Wall clock in the recipient's zone. hourCycle h23: hour12:false renders midnight as "24" in some locales. */
export function localMoment(timezone: string, now: Date): LocalMoment {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) parts[part.type] = part.value;

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour ?? 0),
    weekday: Math.max(0, WEEKDAYS.indexOf(parts.weekday ?? "Sun")),
  };
}

const shiftDays = (date: string, days: number): string => {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() - days);
  return shifted.toISOString().slice(0, 10);
};

/** The digest period a moment falls in, keyed off the local calendar so DST cannot double or skip a send. */
export function periodKey(window: DigestWindow, moment: LocalMoment, sendWeekday: number): string {
  if (window === "daily") return moment.date;

  const since = (moment.weekday - sendWeekday + 7) % 7;
  return shiftDays(moment.date, since);
}

/** Whether the send moment for the current period has arrived. */
export function isDue(
  window: DigestWindow,
  moment: LocalMoment,
  sendHour: number,
  sendWeekday: number,
): boolean {
  if (window === "daily") return moment.hour >= sendHour;

  const period = periodKey("weekly", moment, sendWeekday);
  // Past the send day means a run was missed; catch up rather than skip a week.
  return moment.date > period || moment.hour >= sendHour;
}
