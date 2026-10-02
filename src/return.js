// 「パネルに戻す」の小窓：確認が要るときだけ確認を出し、要らなければそのまま戻す
"use strict";

(async () => {
  const api = globalThis.messenger ?? globalThis.browser;
  const message = document.getElementById("message");
  const list = document.getElementById("list");
  const buttons = document.getElementById("buttons");

  function line(text, className) {
    const p = document.createElement("p");
    if (className) p.className = className;
    p.textContent = text;
    list.append(p);
  }

  function fail(text) {
    message.textContent = text;
    message.className = "err";
    buttons.hidden = true;
  }

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (!tab) return fail("作成ウインドウを確認できませんでした");

  async function run() {
    message.textContent = "パネルに戻しています…";
    message.className = "";
    list.textContent = "";
    buttons.hidden = true;
    let result = null;
    try {
      result = await api.runtime.sendMessage({ type: "returnToPanel", tabId: tab.id });
    } catch (e) {
      // 成功すると作成ウインドウごと閉じるので、ここに来るのは失敗のときだけ
      result = { ok: false, error: (e && e.message) || String(e) };
    }
    if (result && result.ok) window.close();
    else fail(`パネルへ戻せませんでした：${(result && result.error) || "不明なエラー"}`);
  }

  let check = null;
  try {
    check = await api.runtime.sendMessage({ type: "returnCheck", tabId: tab.id });
  } catch (e) {
    check = { ok: false, error: (e && e.message) || String(e) };
  }
  if (!check || !check.ok) return fail((check && check.error) || "パネルへ戻せません");

  if (!check.warn.length) return run();

  message.textContent = "パネルに戻すと、次のようになります。よろしいですか？";
  for (const text of check.warn) line(text);
  for (const text of check.info) line(text, "sub");
  buttons.hidden = false;
  document.getElementById("ok").addEventListener("click", run);
  document.getElementById("cancel").addEventListener("click", () => window.close());
  document.getElementById("ok").focus();
})();
