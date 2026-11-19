import { check } from "./checker.js";
import { processResult, loadState, persist } from "./state.js";
import { telegram } from "./telegram.js";
import { SERVICE, URL_QUEUE, type Result } from "./model.js";
import type { State } from "./state.js";

function report(result: Result, lastConfirmed?: State["lastConfirmed"]) {
  const source = {
    url: URL_QUEUE,
    service: SERVICE,
    checkedAt: new Date().toISOString(),
  };
  if ("failure" in result) {
    console.error(
      JSON.stringify({
        ...source,
        check: "failed",
        message: "Очередь не проверена",
        reason: result.reason,
        lastConfirmed: lastConfirmed
          ? {
              status: lastConfirmed.status,
              checkedAt: new Date(lastConfirmed.at).toISOString(),
            }
          : null,
      }),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify({
      ...source,
      check: "confirmed",
      ...result,
      evidence:
        result.status === "AVAILABLE"
          ? "Разрешённые слоты в ответе очереди совпали с вариантами формы"
          : "В ответе очереди нет разрешённых вариантов, форма показала сообщение о занятых местах",
    }),
  );
}
async function main() {
  const mode = process.argv[2] ?? "--monitor";
  if (!["--dry-run", "--telegram-test", "--monitor"].includes(mode))
    throw new Error("Неизвестный режим");
  if (mode === "--dry-run") {
    const r = await check();
    report(r);
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chat = process.env.TELEGRAM_CHAT_ID ?? "";
  const send = (text: string) => telegram(token, chat)(text);
  if (mode === "--telegram-test") {
    await send("Тест доставки. Мониторинг ДП «Документ», Мюнхен.");
    return;
  }
  if (!token || !chat) {
    console.error(
      "Отсутствуют Telegram Secrets. Проверка очереди выполняется, доставка отключена.",
    );
    process.exitCode = 1;
  }
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("Не настроен каталог ветки monitor-state");
  const state = await loadState(dir);
  if (state.retryAt && state.retryAt > Date.now()) {
    report(
      {
        failure: "UNVERIFIED",
        reason:
          "Проверка отложена по Retry-After до " +
          new Date(state.retryAt).toISOString(),
      },
      state.lastConfirmed,
    );
    return;
  }
  const result = await check();
  report(result, state.lastConfirmed);
  await processResult(result, state, send, (s) => persist(dir, s));
}
main().catch((err: unknown) => {
  const msg =
    err instanceof Error &&
    /^(Telegram:|Отсутствуют Telegram|Не настроен каталог|Повреждено состояние|Неизвестный режим)/.test(
      err.message,
    )
      ? err.message
      : "Ошибка запуска или сохранения состояния. Проверьте наличие ветки monitor-state, state.json и права записи.";
  console.error(msg);
  process.exitCode = 1;
});
