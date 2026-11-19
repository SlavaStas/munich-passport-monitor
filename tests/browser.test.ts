import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, it, expect } from "vitest";
import { chromium, type Browser } from "playwright";
import { observePage, check } from "../src/checker.js";
import { URL_QUEUE } from "../src/model.js";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE,
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(replies: unknown[], http = 200, fail = false) {
  const page = await browser.newPage();
  const html = await readFile(
    new URL("./fixtures/form.html", import.meta.url),
    "utf8",
  );
  const requests: string[] = [];
  await page.route("**/*", async (route) => {
    expect(route.request().url()).toBe(URL_QUEUE);
    if (route.request().method() === "GET") {
      if (fail) return route.abort("connectionfailed");
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: html,
      });
    }
    requests.push(route.request().postData() ?? "");
    return route.fulfill({ status: http, json: replies.shift() ?? {} });
  });
  try {
    const result = await check(
      () => observePage(page),
      async () => {},
    );
    return { result, requests };
  } finally {
    await page.close();
  }
}
it("проверяет отображённое время каждой выбранной даты через форму", async () => {
  const days = ["2026-11-25", "2026-11-26"].map((date) => ({
    date,
    datePart: date,
    isAllowed: true,
  }));
  const times = (t: string) => ({
    timeSlots: [{ startTime: t, slot: t, isAllowed: true }],
  });
  const { result, requests } = await fixture([
    { days },
    times("10:30"),
    times("14:15"),
  ]);
  expect(result).toEqual({
    status: "AVAILABLE",
    slots: [
      { date: "2026-11-25", time: "10:30" },
      { date: "2026-11-26", time: "14:15" },
    ],
  });
  expect(requests).toEqual(["date=", "date=2026-11-25", "date=2026-11-26"]);
});
it("подтверждает пустой список и сообщение формы", async () =>
  expect((await fixture([{ days: [] }])).result.status).toBe("UNAVAILABLE"));
it("потеря формата на второй дате оставляет весь результат неизвестным", async () => {
  const days = ["2026-11-25", "2026-11-26"].map((date) => ({
    datePart: date,
    date,
    isAllowed: true,
  }));
  expect(
    (
      await fixture([
        { days },
        { timeSlots: [{ isAllowed: true, startTime: "08:15", slot: "08:15" }] },
        {},
      ])
    ).result.status,
  ).toBe("UNKNOWN");
});
it("отличает 429 от отсутствия мест", async () =>
  expect((await fixture([{}], 429)).result.status).toBe("UNKNOWN"));
it("отличает сбой загрузки от отсутствия мест", async () =>
  expect((await fixture([], 200, true)).result.status).toBe("ERROR"));

it("различает блокировку страницы и отказ при запросе дат", async () => {
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "text/html",
        headers: { "cf-mitigated": "challenge" },
        body: "private response detail",
      }),
    );
    const result = await check(() => observePage(page));
    expect(result).toMatchObject({
      status: "UNKNOWN",
      reason: "HTTP 403 (GET page, HTML, Cloudflare Challenge)",
    });
    const { result: denied } = await fixture([{}], 403);
    expect(denied).toMatchObject({
      status: "UNKNOWN",
      reason: "HTTP 403 (POST days, JSON)",
    });
  } finally {
    await page.close();
  }
});
