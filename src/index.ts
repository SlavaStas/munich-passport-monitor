import { check } from "./checker.js";
import { processResult, loadState, persist } from "./state.js";
import { telegram } from "./telegram.js";
import { SERVICE } from "./model.js";
async function main() {
  const mode = process.argv[2] ?? "--monitor";
  if (!["--dry-run", "--telegram-test", "--monitor"].includes(mode))
    throw new Error("Неизвестный режим");
  if (mode === "--dry-run") {
    const r = await check();
    console.log(JSON.stringify({ service: SERVICE, ...r }));
    if (r.status === "ERROR" || r.status === "UNKNOWN") process.exitCode = 1;
    return;
  }
  const send = telegram(
    process.env.TELEGRAM_BOT_TOKEN ?? "",
    process.env.TELEGRAM_CHAT_ID ?? "",
  );
  if (mode === "--telegram-test") {
    await send("Тест доставки. Мониторинг ДП «Документ», Мюнхен.");
    return;
  }
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("Не настроен каталог ветки monitor-state");
  const state = await loadState(dir);
  if (state.retryAt && state.retryAt > Date.now()) {
    console.log(
      "Проверка отложена по Retry-After до " +
        new Date(state.retryAt).toISOString(),
    );
    return;
  }
  const result = await check();
  console.log(JSON.stringify({ service: SERVICE, ...result }));
  await processResult(result, state, send, (s) => persist(dir, s));
  if (result.status === "ERROR" || result.status === "UNKNOWN")
    process.exitCode = 1;
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
