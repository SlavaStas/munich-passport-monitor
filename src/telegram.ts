import { setTimeout as delay } from "node:timers/promises";
import { object } from "./model.js";
export function telegram(
  token: string,
  chat: string,
  request: typeof fetch = fetch,
  pause = (ms: number) => delay(ms),
) {
  if (!token || !chat) throw new Error("Отсутствуют Telegram Secrets");
  return async (text: string) => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await request(
          "https://api.telegram.org/bot" + token + "/sendMessage",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            redirect: "error",
            body: JSON.stringify({
              chat_id: chat,
              text,
              link_preview_options: { is_disabled: true },
            }),
            signal: AbortSignal.timeout(12_000),
          },
        );
      } catch {
        throw new Error("Telegram: доставка не подтверждена");
      }
      const body: unknown = await res.json().catch(() => null);
      if (
        res.ok &&
        object(body) &&
        body.ok === true &&
        object(body.result) &&
        Number.isSafeInteger(body.result.message_id)
      )
        return;
      if (
        res.status === 429 &&
        !attempt &&
        object(body) &&
        object(body.parameters)
      ) {
        const wait = body.parameters.retry_after;
        if (
          typeof wait === "number" &&
          Number.isInteger(wait) &&
          wait >= 1 &&
          wait <= 30
        ) {
          await pause(wait * 1000);
          continue;
        }
      }
      throw new Error(
        "Telegram: доставка не подтверждена (HTTP " + res.status + ")",
      );
    }
  };
}
