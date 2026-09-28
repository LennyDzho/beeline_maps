export { isRegionalTimezone, regionalTimeToInstant, instantToRegionalTime, scheduleTimeToInstant } from "@mmi/provider-contracts";

export const regionTimezones = [
  ["Europe/Kaliningrad", "GMT+2 · Калининград"],
  ["Europe/Moscow", "GMT+3 · Москва"],
  ["Europe/Samara", "GMT+4 · Самара"],
  ["Asia/Yekaterinburg", "GMT+5 · Екатеринбург"],
  ["Asia/Omsk", "GMT+6 · Омск"],
  ["Asia/Novosibirsk", "GMT+7 · Новосибирск"],
  ["Asia/Irkutsk", "GMT+8 · Иркутск"],
  ["Asia/Yakutsk", "GMT+9 · Якутск"],
  ["Asia/Vladivostok", "GMT+10 · Владивосток"],
  ["Asia/Magadan", "GMT+11 · Магадан"],
  ["Asia/Kamchatka", "GMT+12 · Камчатка"],
] as const;
