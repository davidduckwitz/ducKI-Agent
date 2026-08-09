const input = (typeof skillInput === "object" && skillInput !== null) ? skillInput : {};

const showDate = typeof input.showDate === "boolean" ? input.showDate : false;
const showTime = typeof input.showTime === "boolean" ? input.showTime : false;
const showDay = typeof input.showDay === "boolean" ? input.showDay : false;
const locale = typeof input.locale === "string" && input.locale.trim().length > 0 ? input.locale : "de-DE";

const useDefaults = !showDate && !showTime && !showDay;
const finalShowDate = useDefaults ? true : showDate;
const finalShowTime = useDefaults ? true : showTime;
const finalShowDay = useDefaults ? true : showDay;

const now = new Date();
const parts = [];

if (finalShowDate) {
  parts.push(new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(now));
}

if (finalShowTime) {
  parts.push(new Intl.DateTimeFormat(locale, { timeStyle: "long" }).format(now));
}

if (finalShowDay) {
  parts.push(new Intl.DateTimeFormat(locale, { weekday: "long" }).format(now));
}

const output = parts.join(" | ");
console.log("Datum/Uhrzeit/Tag:", output);

return {
  locale,
  showDate: finalShowDate,
  showTime: finalShowTime,
  showDay: finalShowDay,
  output,
  iso: now.toISOString(),
};
