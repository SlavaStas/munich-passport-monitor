import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  choices,
  dateKey,
  timeKey,
  httpStatus,
  Problem,
  summarize,
} from "../src/model.js";
import { check } from "../src/checker.js";
import {
  initial,
  processResult,
  loadState,
  persist,
  type State,
} from "../src/state.js";
import { telegram } from "../src/telegram.js";

const slot = { date: "2026-11-25", time: "10:30" };
const ok = async () => {};
describe("данные формы", () => {
  it("берёт только явно доступные варианты", () => {
    expect(
      choices(
        {
          days: [
            { isAllowed: true, datePart: slot.date, date: "25.11.2026" },
            { isAllowed: false },
          ],
        },
        "days",
      ),
    ).toEqual([{ value: slot.date, label: "25.11.2026" }]);
    expect(
      choices(
        {
          timeSlots: [
            { isAllowed: true, startTime: "10:30:00", slot: "10:30" },
          ],
        },
        "timeSlots",
      ),
    ).toEqual([{ value: "10:30:00", label: "10:30" }]);
  });
  it.each([
    null,
    {},
    { days: null },
    { days: [{ isAllowed: 1 }] },
    { days: [{ isAllowed: true }] },
  ])("отклоняет незнакомый формат", (body) =>
    expect(() => choices(body, "days")).toThrow(Problem),
  );
  it("понимает календарные даты и время", () => {
    expect(dateKey("29.02.2028")).toBe("2028-02-29");
    expect(dateKey(slot.date)).toBe(slot.date);
    expect(() => dateKey("29.02.2027")).toThrow();
    expect(() => dateKey("25/11/26")).toThrow();
    expect(timeKey("10:30:00")).toBe("10:30");
    expect(() => timeKey("24:01")).toThrow();
  });
  it("не повторяет 403 и 429", async () => {
    for (const code of [403, 429]) {
      const run = vi.fn(async () => {
        httpStatus(code);
        return summarize([]);
      });
      expect(await check(run, ok)).toMatchObject({ failure: "UNVERIFIED" });
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
  it("повторяет временный сбой только один раз", async () => {
    const run = vi.fn(async () => {
      httpStatus(503);
      return summarize([]);
    });
    const backoff = vi.fn(ok);
    expect(await check(run, backoff)).toMatchObject({ failure: "ERROR" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(backoff).toHaveBeenCalledOnce();
  });
});
describe("уведомления", () => {
  it("новый слот один раз, после подтверждённого исчезновения — снова", async () => {
    let state = initial();
    const send = vi.fn(ok);
    const save = async (s: State) => {
      state = structuredClone(s);
    };
    const visit = () => processResult(summarize([slot]), state, send, save);
    await visit();
    await visit();
    const beforeFailure = state.lastConfirmed;
    await processResult(
      { failure: "UNVERIFIED", reason: "CAPTCHA" },
      state,
      send,
      save,
    );
    expect(state.lastConfirmed).toEqual(beforeFailure);
    expect(beforeFailure?.status).toBe("AVAILABLE");
    await visit();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls.flat().join(" ")).toContain("25.11.2026 — 10:30");
    await processResult(summarize([]), state, send, save);
    await visit();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("при ошибке доставки не отмечает слот", async () => {
    const save = vi.fn(ok);
    await expect(
      processResult(
        summarize([slot]),
        initial(),
        async () => {
          throw Error("delivery");
        },
        save,
      ),
    ).rejects.toThrow();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ notified: [] }),
    );
  });
  it("ограничивает диагностические сообщения и сохраняет слоты", async () => {
    let state = { ...initial(), notified: ["2026-11-25 10:30"] };
    const send = vi.fn(ok);
    const save = async (s: State) => {
      state = structuredClone(s);
    };
    const fail = (now: number) =>
      processResult(
        { failure: "ERROR", reason: "503" },
        state,
        send,
        save,
        now,
      );
    for (let i = 1; i <= 6; i++) await fail(10000 + i);
    expect(send).toHaveBeenCalledOnce();
    expect(state.notified).toHaveLength(1);
    await fail(90_000_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("после частичной доставки сохраняет только отправленную часть", async () => {
    let state = initial();
    const send = vi
      .fn(ok)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Error("telegram"));
    const slots = Array.from({ length: 75 }, (_, i) => ({
      date: slot.date,
      time:
        String(10 + Math.floor(i / 60)) + ":" + String(i % 60).padStart(2, "0"),
    }));
    await expect(
      processResult(summarize(slots), state, send, async (s) => {
        state = structuredClone(s);
      }),
    ).rejects.toThrow();
    expect(state.notified).toHaveLength(70);
    const retry = vi.fn(ok);
    await processResult(summarize(slots), state, retry, ok);
    expect(retry).toHaveBeenCalledOnce();
  });
});
describe("Telegram API", () => {
  it("проверяет message_id", async () => {
    const request = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 1 } }),
    );
    await telegram("fake", "test", request)("test");
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([
    Response.json({ ok: false }),
    Response.json({ ok: true }),
    new Response("", { status: 502 }),
  ])("не подтверждает ошибочную доставку", async (res) => {
    await expect(
      telegram("fake", "test", async () => res)("test"),
    ).rejects.toThrow();
  });
  it("не повторяет сетевой сбой с неизвестным исходом", async () => {
    const req = vi.fn(async () => {
      throw Error("network");
    });
    await expect(telegram("fake", "test", req)("test")).rejects.toThrow();
    expect(req).toHaveBeenCalledOnce();
  });
  it("при явном 429 ждёт retry_after", async () => {
    const req = vi
      .fn(async () => Response.json({ ok: true, result: { message_id: 1 } }))
      .mockResolvedValueOnce(
        Response.json(
          { ok: false, parameters: { retry_after: 1 } },
          { status: 429 },
        ),
      );
    const pause = vi.fn(ok);
    await telegram("fake", "test", req, pause)("test");
    expect(pause).toHaveBeenCalledWith(1000);
  });
});
it("восстанавливает подтверждения в чистом git checkout; повреждённое состояние останавливает запуск", async () => {
  const root = await mkdtemp(join(tmpdir(), "queue-state-"));
  const script = resolve("scripts/prepare-state.sh");
  const git = (dir: string, ...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  try {
    git(root, "init", "--bare", "--initial-branch=main", "remote");
    git(root, "clone", "remote", "first");
    const first = join(root, "first");
    git(
      first,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.org",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    );
    git(first, "push", "origin", "main");
    const setup = (checkout: string, dir: string) =>
      execFileSync("bash", [script], {
        cwd: join(root, checkout),
        env: { ...process.env, STATE_DIR: dir },
        stdio: "pipe",
      });
    const one = join(root, "one");
    setup("first", one);
    const state = await loadState(one);
    await processResult(summarize([slot]), state, ok, (s) => persist(one, s));
    git(root, "clone", "remote", "second");
    const two = join(root, "two");
    setup("second", two);
    const send = vi.fn(ok);
    await processResult(summarize([slot]), await loadState(two), send, (s) =>
      persist(two, s),
    );
    expect(send).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(two, "state.json"), "utf8")).notified,
    ).toContain("2026-11-25 10:30");
    await writeFile(join(two, "state.json"), "{}");
    await expect(loadState(two)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
