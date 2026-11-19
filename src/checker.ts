import {
  chromium,
  errors,
  type Locator,
  type Page,
  type Response,
} from "playwright";
import { setTimeout as delay } from "node:timers/promises";
import {
  choices,
  dateKey,
  FULL,
  httpStatus,
  Problem,
  SERVICE,
  summarize,
  timeKey,
  URL_QUEUE,
  type Choice,
  type Result,
  type Slot,
} from "./model.js";

const timeout = 18_000;
const challenge =
  /just a moment|verify (?:that )?you are human|access denied|checking your browser/i;
async function hasChallenge(page: Page) {
  return (
    challenge.test(await page.title()) ||
    (await page
      .getByRole("dialog")
      .filter({ hasText: /captcha|не робот|verify.*human/i })
      .first()
      .isVisible())
  );
}
async function checkResponse(
  response: Response,
  stage: "page" | "days" | "timeSlots",
) {
  const headers = response.headers();
  const status = response.status();
  const challenged = headers["cf-mitigated"] === "challenge";
  if (status !== 403 && !(status === 200 && challenged)) {
    httpStatus(status, headers["retry-after"]);
    return;
  }

  const method = stage === "page" ? "GET" : "POST";
  const media = headers["content-type"]?.split(";")[0]?.trim();
  const format =
    media === "text/html"
      ? "HTML"
      : media === "application/json"
        ? "JSON"
        : "other";
  const evidence = [method + " " + stage, format];
  if (challenged) evidence.push("Cloudflare Challenge");
  else if (status === 403 && (format === "HTML" || format === "JSON")) {
    // Classify known text without writing the response body or request data to the log.
    const body = (await response.text().catch(() => "")).slice(0, 65536);
    if (
      /sorry, you have been blocked/i.test(body) &&
      /cloudflare ray id/i.test(body)
    )
      evidence.push("Cloudflare block page");
    else if (/invalid csrf token|csrf token mismatch/i.test(body))
      evidence.push("response reports CSRF token error");
  }
  const ray = headers["cf-ray"];
  if (ray && /^[0-9a-f]{16}(?:-[a-z]{3})?$/i.test(ray))
    evidence.push("CF-Ray " + ray);
  throw new Problem(
    "UNKNOWN",
    "HTTP " + status + " (" + evidence.join(", ") + ")",
  );
}
async function selectAndRead(
  page: Page,
  select: Locator,
  option: { value: string } | { label: string },
  kind: "days" | "timeSlots",
) {
  // Listen before changing the selection. Only accept a response to this queue form.
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url() === URL_QUEUE &&
        r.request().method() === "POST" &&
        ["xhr", "fetch"].includes(r.request().resourceType()),
      { timeout },
    ),
    select.selectOption(option),
  ]);
  await checkResponse(response, kind);
  if (!response.headers()["content-type"]?.includes("json"))
    throw new Problem("UNKNOWN", "Форма вернула ответ вне формата JSON");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Problem("UNKNOWN", "Ответ JSON пуст или повреждён");
  }
  return choices(body, kind);
}
async function verifyRendered(
  page: Page,
  id: "date" | "time",
  expected: Choice[],
) {
  if (!expected.length) {
    await page
      .locator("#services [role=alert]")
      .filter({ hasText: FULL })
      .waitFor({ state: "visible", timeout });
    return;
  }
  const select = page.locator("#services #" + id);
  await select.waitFor({ state: "visible", timeout });
  await page.waitForFunction(
    ({ id, expected }) => {
      const elem = document.querySelector<HTMLSelectElement>(
        "#services #" + id,
      );
      if (!elem) return false;
      const actual = Array.from(elem.options).filter((o) => o.value);
      return (
        actual.length === expected.length &&
        expected.every((e) =>
          actual.some(
            (o) =>
              !o.disabled && o.value === e.value && o.text.trim() === e.label,
          ),
        )
      );
    },
    { id, expected },
    { timeout },
  );
}
export async function observePage(page: Page): Promise<Result> {
  page.setDefaultTimeout(timeout);
  let networkFailure = false;
  page.on("requestfailed", (req) => {
    if (req.url() === URL_QUEUE) networkFailure = true;
  });
  try {
    const doc = await page.goto(URL_QUEUE, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if (!doc) throw new Problem("ERROR", "Нет ответа страницы", true);
    await checkResponse(doc, "page");
    if (page.url() !== URL_QUEUE || (await hasChallenge(page)))
      throw new Problem("UNKNOWN", "Перенаправление или проверка доступа");
    await page
      .getByRole("heading", { name: /Електронна черга.*Мюнхен/ })
      .waitFor();
    const service = page.locator("#services #service");
    await service.waitFor({ state: "visible" });
    // A server-rendered select can appear before the JavaScript form is initialized.
    const days = await selectAndRead(page, service, { label: SERVICE }, "days");
    await verifyRendered(page, "date", days);
    const slots: Slot[] = [];
    for (const day of days) {
      const date = dateKey(day.value);
      const times = await selectAndRead(
        page,
        page.locator("#services #date"),
        { value: day.value },
        "timeSlots",
      );
      await verifyRendered(page, "time", times);
      for (const time of times) slots.push({ date, time: timeKey(time.value) });
    }
    return summarize(slots);
  } catch (err) {
    if (err instanceof Problem) throw err;
    if (await hasChallenge(page).catch(() => false))
      throw new Problem("UNKNOWN", "Страница запросила проверку доступа");
    if (networkFailure)
      throw new Problem("ERROR", "Сбой сетевого запроса к очереди", true);
    if (err instanceof errors.TimeoutError)
      throw new Problem(
        "UNKNOWN",
        "Форма или ответ очереди не подтверждены до таймаута",
      );
    throw new Problem("ERROR", "Сбой загрузки или браузера", true);
  }
}
async function once() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observePage(await browser.newPage()),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Problem("ERROR", "Превышено время проверки")),
          120_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}
export async function check(
  run = once,
  pause = () => delay(2000),
): Promise<Result> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const problem =
        err instanceof Problem
          ? err
          : new Problem("ERROR", "Не удалось запустить Chromium");
      if (!attempt && problem.retryable) {
        await pause();
        continue;
      }
      return {
        status: problem.status,
        reason: problem.message,
        retryAt: problem.retryAt,
      };
    }
  }
}
