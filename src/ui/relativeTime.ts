const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

const startOfDay = (d: Date): number => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
};

export const formatRelativeTime = (iso: string, now: Date = new Date()): string => {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return iso.slice(0, 10);
    const hhmm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
    const today = startOfDay(now);
    const that = startOfDay(t);
    const dayDiff = Math.round((today - that) / 86_400_000);
    if (dayDiff === 0) return `today  ${hhmm}`;
    if (dayDiff === 1) return `yest.  ${hhmm}`;
    if (dayDiff > 1 && dayDiff < 7) return `${WEEKDAY[t.getDay()]}    ${hhmm}`;
    return `${pad2(t.getMonth() + 1)}/${pad2(t.getDate())}  ${hhmm}`;
};
