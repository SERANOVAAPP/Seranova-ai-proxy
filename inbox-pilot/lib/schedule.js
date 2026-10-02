// When is the daily brief due? Pure function so it is easy to test.
// Returns the local date string ("2026-10-02") if a brief should be built
// now, otherwise null.
export function briefDueDate(profile, now, lastBriefDate) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: profile.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (localDate === lastBriefDate) return null;
  if (!profile.weekendBrief && (parts.weekday === "Sat" || parts.weekday === "Sun")) return null;
  const [h, m] = profile.briefTime.split(":").map(Number);
  const minutesNow = Number(parts.hour) * 60 + Number(parts.minute);
  return minutesNow >= h * 60 + m ? localDate : null;
}
