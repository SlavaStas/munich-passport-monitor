import { readFile, rename, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { object, slotKey, URL_QUEUE, type Result } from "./model.js";

export type State = {
  version: 1;
  notified: string[];
  failures: number;
  lastDiagnostic: number;
  retryAt?: number;
  lastConfirmed?: { status: "AVAILABLE" | "UNAVAILABLE"; at: number };
};
export const initial = (): State => ({
  version: 1,
  notified: [],
  failures: 0,
  lastDiagnostic: 0,
});
export async function loadState(dir: string): Promise<State> {
  const s: unknown = JSON.parse(
    await readFile(join(dir, "state.json"), "utf8"),
  );
  if (
    !object(s) ||
    (s.retryAt !== undefined &&
      (typeof s.retryAt !== "number" ||
        !Number.isSafeInteger(s.retryAt) ||
        s.retryAt < 0)) ||
    (s.lastConfirmed !== undefined &&
      (!object(s.lastConfirmed) ||
        !["AVAILABLE", "UNAVAILABLE"].includes(
          String(s.lastConfirmed.status),
        ) ||
        typeof s.lastConfirmed.at !== "number" ||
        !Number.isSafeInteger(s.lastConfirmed.at) ||
        s.lastConfirmed.at <= 0)) ||
    s.version !== 1 ||
    !Array.isArray(s.notified) ||
    !s.notified.every(
      (k) => typeof k === "string" && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(k),
    ) ||
    typeof s.failures !== "number" ||
    !Number.isSafeInteger(s.failures) ||
    s.failures < 0 ||
    typeof s.lastDiagnostic !== "number" ||
    !Number.isSafeInteger(s.lastDiagnostic) ||
    s.lastDiagnostic < 0
  )
    throw new Error("Повреждено состояние");
  return {
    version: 1,
    notified: s.notified,
    lastConfirmed: s.lastConfirmed as State["lastConfirmed"],
    failures: s.failures,
    lastDiagnostic: s.lastDiagnostic,
    retryAt: s.retryAt as number | undefined,
  };
}
export async function persist(dir: string, s: State) {
  const target = join(dir, "state.json");
  await writeFile(target + ".tmp", JSON.stringify(s) + "\n", { mode: 0o600 });
  await rename(target + ".tmp", target);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    }).toString();
  if (git("branch", "--show-current").trim() !== "monitor-state")
    throw new Error("Неверная ветка состояния");
  if (!git("status", "--porcelain", "--", "state.json").trim()) return;
  git("add", "--", "state.json");
  git("commit", "-m", "Update appointment monitor state");
  git("push", "origin", "HEAD:refs/heads/monitor-state");
}
const checkedAt = (ms: number) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Vienna",
    dateStyle: "short",
    timeStyle: "short",
  }).format(ms);
export async function processResult(
  r: Result,
  old: State,
  send: (text: string) => Promise<void>,
  save: (s: State) => Promise<void>,
  now = Date.now(),
) {
  const s: State = { ...old, notified: [...old.notified] };
  if ("failure" in r) {
    s.failures++;
    s.retryAt = r.retryAt;
    await save(s);
    if (
      s.failures >= 3 &&
      (!s.lastDiagnostic || now - s.lastDiagnostic >= 86_400_000)
    ) {
      await send(
        "Мониторинг Мюнхена: " +
          s.failures +
          " проверок подряд без результата. " +
          (old.lastConfirmed
            ? "Последняя подтверждённая проверка " +
              checkedAt(old.lastConfirmed.at) +
              " (Вена), " +
              old.lastConfirmed.status
            : "Подтверждённых проверок пока нет") +
          " — " +
          r.reason +
          "\n" +
          URL_QUEUE,
      );
      s.lastDiagnostic = now;
      await save(s);
    }
    return;
  }
  const present = new Set(r.status === "AVAILABLE" ? r.slots.map(slotKey) : []);
  s.notified = s.notified.filter((k) => present.has(k));
  s.lastConfirmed = { status: r.status, at: now };
  s.failures = 0;
  s.lastDiagnostic = 0;
  delete s.retryAt;
  if (JSON.stringify(s) !== JSON.stringify(old)) await save(s);
  const sent = new Set(s.notified);
  const unseen = [...present].filter((k) => !sent.has(k)).sort();
  for (let i = 0; i < unseen.length; i += 70) {
    const batch = unseen.slice(i, i + 70);
    const lines = batch.map(
      (k) =>
        "• " +
        k.slice(0, 10).split("-").reverse().join(".") +
        " — " +
        k.slice(11),
    );
    await send(
      [
        "Свободные места на загранпаспорт!",
        "ДП «Документ» — Мюнхен",
        "Доступные слоты:\n" + lines.join("\n"),
        URL_QUEUE,
        "Проверено: " + checkedAt(now) + " (Europe/Vienna)",
      ].join("\n\n"),
    );
    s.notified.push(...batch);
    await save(s);
  }
}
