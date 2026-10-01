// replyfold 背景スクリプト：パネルの登録／メール情報の返答／返信の送信
"use strict";

const api = globalThis.messenger ?? globalThis.browser;
const SCRIPT_ID = "replyfold-panel";
const LOG = "[replyfold]";

// ---------------------------------------------------------------
// 1. パネルの登録
// ---------------------------------------------------------------

// 新しく開くメールへ自動で差し込む設定。登録済みなら何もしない（二重登録はエラーになるため）
async function registerPanel() {
  try {
    const registered = await api.scripting.messageDisplay.getRegisteredScripts();
    if (registered.some((s) => s.id === SCRIPT_ID)) {
      console.log(LOG, "登録済みのため登録を省略");
      return;
    }
    await api.scripting.messageDisplay.registerScripts([
      {
        id: SCRIPT_ID,
        js: ["panel.js"],
        css: ["panel.css"],
        runAt: "document_idle",
      },
    ]);
    console.log(LOG, "パネルを登録");
  } catch (e) {
    console.error(LOG, "パネルの登録に失敗", e);
  }
}

// 登録は新しく開いたメールにしか効かないので、既に開いているタブへは手動で入れる
async function injectIntoOpenTabs() {
  let tabs = [];
  try {
    tabs = await api.tabs.query({ type: ["mail", "messageDisplay"] });
  } catch (e) {
    console.error(LOG, "タブ一覧の取得に失敗", e);
    return;
  }
  for (const tab of tabs) {
    try {
      // メールを表示していないタブは対象外
      const list = await api.messageDisplay.getDisplayedMessages(tab.id);
      if (!list || list.messages.length !== 1) continue;
      await api.scripting.insertCSS({ target: { tabId: tab.id }, files: ["panel.css"] });
      // panel.js 側に二重差し込み防止があるので、登録分と重なっても害はない
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["panel.js"] });
      console.log(LOG, "既存タブへ差し込み", tab.id);
    } catch (e) {
      console.warn(LOG, "既存タブへの差し込みに失敗（続行）", tab.id, e);
    }
  }
}

// 背景スクリプトは休止・再開するため、登録の確認は毎回行う
registerPanel();

// 既存タブへの差し込みは、導入・更新時と起動時だけ（再開のたびに CSS を重ねないため）
api.runtime.onInstalled.addListener(async () => {
  await registerPanel();
  await injectIntoOpenTabs();
});
api.runtime.onStartup.addListener(async () => {
  await registerPanel();
  await injectIntoOpenTabs();
});

// ---------------------------------------------------------------
// 2. メール情報の返答
// ---------------------------------------------------------------

// 送信元タブで表示中のメールを1通だけ返す。複数表示・取得不可なら null
async function getDisplayedHeader(sender) {
  const tabId = sender?.tab?.id;
  if (tabId === undefined) return null;
  try {
    const list = await api.messageDisplay.getDisplayedMessages(tabId);
    if (!list || !Array.isArray(list.messages) || list.messages.length !== 1) return null;
    return list.messages[0];
  } catch (e) {
    console.warn(LOG, "表示中メールの取得に失敗", e);
    return null;
  }
}

// 「名前 <アドレス>」からアドレス部分だけを小文字で取り出す
function emailOf(entry) {
  const m = /<([^>]+)>/.exec(entry || "");
  return (m ? m[1] : entry || "").trim().toLowerCase();
}

// 「a, "姓, 名" <b>」のような1行を宛先ごとに分ける（引用符と <> の中のカンマでは切らない）
function splitAddresses(line) {
  const out = [];
  let cur = "";
  let quote = false;
  let angle = false;
  for (const ch of line || "") {
    if (ch === '"') quote = !quote;
    else if (!quote && ch === "<") angle = true;
    else if (!quote && ch === ">") angle = false;
    if ((ch === "," || ch === ";") && !quote && !angle) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// 同じアドレスの重複と、除外対象を取り除く
function uniqueAddresses(list, exclude = new Set()) {
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const email = emailOf(entry);
    if (!email || seen.has(email) || exclude.has(email)) continue;
    seen.add(email);
    out.push(entry);
  }
  return out;
}

// 自分のアドレス一覧（全員に返信で自分を宛先から外すため）
async function ownEmails() {
  try {
    const identities = await api.identities.list();
    return new Set(identities.map((i) => (i.email || "").toLowerCase()).filter(Boolean));
  } catch (e) {
    console.warn(LOG, "自分のアドレスを取得できなかった", e);
    return new Set();
  }
}

// Reply-To ヘッダー（返信先の指定）。無ければ空
async function replyToOf(messageId) {
  try {
    const full = await api.messages.getFull(messageId);
    const raw = full?.headers?.["reply-to"] ?? [];
    return uniqueAddresses(raw.flatMap((line) => splitAddresses(line)));
  } catch (e) {
    console.warn(LOG, "Reply-To を取得できなかった", e);
    return [];
  }
}

// パネルに初期表示する宛先・Cc・件名を決める。
// Thunderbird 任せにせずここで決めるのは、パネルに見えている宛先と実際の送信先を必ず一致させるため
async function replyDefaults(header) {
  const own = await ownEmails();
  const author = header.author ?? "";
  const recipients = header.recipients ?? [];
  const ccList = header.ccList ?? [];
  const fromSelf = own.has(emailOf(author));
  const replyTo = await replyToOf(header.id);

  // 自分が送ったメールへの返信は、元の宛先へ送る
  let base = replyTo.length ? replyTo : fromSelf ? uniqueAddresses(recipients) : [author];
  if (!base.length) base = [author];

  const baseEmails = new Set(base.map(emailOf));
  const skip = new Set([...own, ...baseEmails]);
  const others = fromSelf ? ccList : [...recipients, ...ccList];

  const subject = header.subject ?? "";
  return {
    sender: { to: base, cc: [] },
    all: { to: base, cc: uniqueAddresses(others, skip) },
    subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
  };
}

// 差出人の選択肢と初期値。
// 初期値は「元メールの宛先（To → Cc の順）に入っていた自分のアドレス」。
// 見つからなければ、そのメールが入っているアカウントの既定の差出人にする。
// 選べるのは Thunderbird に登録済みの差出人だけ（未登録のアドレスからは送れないため）
async function fromChoices(header) {
  let identities = [];
  try {
    identities = await api.identities.list();
  } catch (e) {
    console.warn(LOG, "差出人の一覧を取得できなかった", e);
    return { options: [], defaultId: null, matched: false };
  }
  const options = identities
    .filter((i) => i.email)
    .map((i) => ({ id: i.id, email: i.email, label: i.name ? `${i.name} <${i.email}>` : i.email }));

  const addressed = [...(header.recipients ?? []), ...(header.ccList ?? [])].map(emailOf);
  let chosen = null;
  for (const email of addressed) {
    chosen = options.find((o) => o.email.toLowerCase() === email);
    if (chosen) break;
  }
  const matched = !!chosen;
  if (!chosen) {
    try {
      const accountId = header.folder?.accountId;
      const account = accountId ? await api.accounts.get(accountId) : null;
      const first = account?.identities?.[0]?.id;
      chosen = options.find((o) => o.id === first) ?? null;
    } catch (e) {
      console.warn(LOG, "アカウントの既定の差出人を取得できなかった", e);
    }
  }
  return { options, defaultId: (chosen ?? options[0])?.id ?? null, matched };
}

async function handleGetInfo(sender) {
  const header = await getDisplayedHeader(sender);
  if (!header) return null;
  return {
    from: await fromChoices(header),
    id: header.id,
    author: header.author ?? "",
    subject: header.subject ?? "",
    // メールIDは再起動で変わるため、下書きの照合用に Message-ID ヘッダーも渡す
    headerMessageId: header.headerMessageId ?? "",
    // 引用の見出し行（「On 日時, 名前 wrote:」）に使う受信日時
    date: header.date instanceof Date ? header.date.getTime() : null,
    defaults: await replyDefaults(header),
  };
}

// ---------------------------------------------------------------
// 3. 送信
// ---------------------------------------------------------------

// 本文の組み立て方：Thunderbird が自動で入れた引用は捨て、署名だけ残す。
// 引用を入れるか・「>」を付けるかはパネルの設定で決めるため、引用はこちらで作り直す。
// quote は { header, body, mark } か null（引用なし、または入力欄に引用が含まれている）

// 文字列を1行ずつテキストノードで入れた要素を作る（HTML として解釈させない＝エスケープ済み）
function linesBlock(doc, tag, text) {
  const block = doc.createElement(tag);
  text.split("\n").forEach((line, i) => {
    if (i > 0) block.appendChild(doc.createElement("br"));
    block.appendChild(doc.createTextNode(line));
  });
  return block;
}

// HTML 本文：本文 → 引用 → 署名 の順。「>」ありは引用ブロック（縦線つき）として入れる
function buildHtml(html, text, quote) {
  const doc = new DOMParser().parseFromString(html ?? "", "text/html");
  for (const node of doc.querySelectorAll("blockquote[type='cite'], .moz-cite-prefix")) {
    if (!node.closest(".moz-signature")) node.remove();
  }
  const parts = [linesBlock(doc, "div", text), doc.createElement("br")];
  if (quote) {
    const header = linesBlock(doc, "div", quote.header);
    header.className = "moz-cite-prefix";
    const body = linesBlock(doc, quote.mark ? "blockquote" : "div", quote.body);
    if (quote.mark) body.setAttribute("type", "cite");
    parts.push(header, body, doc.createElement("br"));
  }
  doc.body.prepend(...parts);
  return doc.documentElement.outerHTML;
}

// プレーンテキスト本文：本文 → 引用 → 署名 の順。署名は区切り行「-- 」以降
function buildPlain(plain, text, quote) {
  const source = plain ?? "";
  const at = source.lastIndexOf("\n-- \n");
  const signature = at >= 0 ? source.slice(at) : "";
  let out = text;
  if (quote) {
    const body = quote.mark
      ? quote.body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")
      : quote.body;
    out += `\n\n${quote.header}\n${body}`;
  }
  return signature ? `${out}\n${signature}` : `${out}\n`;
}

function errorText(e) {
  if (!e) return "不明なエラー";
  return typeof e === "string" ? e : e.message || String(e);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 即時送信。作成ウインドウが準備中（not ready）の間は少し待って送り直す。
// 事前に compose.getComposeState で確かめないのは、Thunderbird 156 では
// この API が常に空を返し、送信できる状態を判定できないため
async function sendWhenReady(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await api.compose.sendMessage(tabId, { mode: "sendNow" });
    } catch (e) {
      const notReady = /not ready/i.test(errorText(e));
      if (!notReady) throw e;
      if (Date.now() >= deadline) {
        // 待っても送信できないままのとき。いちばん多い原因はオフライン作業（送信ボタンが「後で送信」になる）
        throw new Error(
          "作成ウインドウが送信できる状態になりませんでした。Thunderbird がオフライン作業になっていないか確認してください"
        );
      }
      await sleep(250);
    }
  }
}

const sending = new Set(); // 同じメールへの二重送信を防ぐ

async function handleSend(msg, sender) {
  const messageId = msg.messageId;
  const text = typeof msg.text === "string" ? msg.text.replace(/\r\n?/g, "\n") : "";
  const replyAll = msg.replyAll === true;

  const to = uniqueAddresses(splitAddresses(msg.to));
  const cc = uniqueAddresses(splitAddresses(msg.cc));
  const bcc = uniqueAddresses(splitAddresses(msg.bcc));
  const subject = typeof msg.subject === "string" ? msg.subject.trim() : "";
  const quote =
    msg.quote && typeof msg.quote.body === "string" && msg.quote.body.trim()
      ? {
          header: String(msg.quote.header ?? ""),
          body: msg.quote.body.replace(/\r\n?/g, "\n"),
          mark: msg.quote.mark !== false,
        }
      : null;

  // popout＝送信せず、同じ内容を標準の作成ウインドウへ引き継ぐ（書きかけでもよい）
  const popout = msg.type === "popout";

  // オフライン作業中は即時送信できない。作成ウインドウを開く前に止める
  if (!popout && globalThis.navigator?.onLine === false) {
    return {
      ok: false,
      error: "Thunderbird がオフライン作業になっています。オンラインに戻してから送信してください",
    };
  }
  if (!popout && !text.trim()) return { ok: false, error: "本文が空です" };
  if (!popout && !to.length) return { ok: false, error: "宛先が空です" };
  const bad = [...to, ...cc, ...bcc].find((entry) => !/^[^\s@]+@[^\s@]+$/.test(emailOf(entry)));
  if (bad) return { ok: false, error: `宛先の形式が正しくありません：${bad}` };

  // パネルが言うメールと、実際にそのタブで表示中のメールが一致するか確かめる（誤送信防止）
  const header = await getDisplayedHeader(sender);
  if (!header || header.id !== messageId) {
    return { ok: false, error: "表示中のメールを確認できませんでした。メールを開き直してください" };
  }
  if (sending.has(messageId)) return { ok: false, error: "このメールへの返信を送信中です" };
  sending.add(messageId);

  let composeTab = null;
  try {
    // ① 標準の返信作成を開く
    console.log(LOG, "① 返信作成を開く", { messageId, replyAll });
    composeTab = await api.compose.beginReply(
      messageId,
      replyAll ? "replyToAll" : "replyToSender",
      typeof msg.identityId === "string" && msg.identityId ? { identityId: msg.identityId } : undefined
    );

    // ② すぐ最小化（失敗しても続行）。別ウインドウへ引き継ぐときは見せたままにする
    if (!popout) {
      try {
        await api.windows.update(composeTab.windowId, { state: "minimized" });
        console.log(LOG, "② 作成ウインドウを最小化");
      } catch (e) {
        console.warn(LOG, "② 最小化に失敗（続行）", e);
      }
    }

    // ③ 差出人をパネルの選択に合わせてから、現在の本文（署名入り）を取得する。
    //    先に差出人を変えるのは、差出人ごとに署名が入れ替わるため
    let details = await api.compose.getComposeDetails(composeTab.id);
    const identityId = typeof msg.identityId === "string" ? msg.identityId : "";
    if (identityId && details.identityId !== identityId) {
      await api.compose.setComposeDetails(composeTab.id, { identityId });
      details = await api.compose.getComposeDetails(composeTab.id);
      if (details.identityId !== identityId) {
        throw new Error("差出人を切り替えられませんでした");
      }
      console.log(LOG, "③ 差出人を切り替え", identityId);
    }
    console.log(LOG, "③ 本文を取得", { isPlainText: details.isPlainText });

    // ④ 形式に合わせて本文を作り直す。片方だけ渡す（形式は途中で変えられないため）。
    //    宛先・Cc・件名はパネルの値で上書きする
    const update = details.isPlainText
      ? { plainTextBody: buildPlain(details.plainTextBody, text, quote) }
      : { body: buildHtml(details.body, text, quote) };
    update.to = to;
    update.cc = cc;
    // Bcc 欄を出しているときだけ上書きする。隠しているときは触らず、
    // アカウント設定の自動 Bcc（自分宛ての控えなど）を生かす
    if (typeof msg.bcc === "string") update.bcc = bcc;
    if (subject) update.subject = subject;
    await api.compose.setComposeDetails(composeTab.id, update);
    console.log(LOG, "④ 本文・宛先・件名を差し込み", { to: to.length, cc: cc.length });
    if (popout) return { ok: true };

    // ⑤ 即時送信（準備中なら待って送り直す）
    const result = await sendWhenReady(composeTab.id);
    console.log(LOG, "⑤ 送信完了", result?.mode, result?.headerMessageId);
    return { ok: true };
  } catch (e) {
    console.error(LOG, "送信に失敗", e);
    let error = errorText(e);
    // 作成ウインドウを戻し、ユーザーが手で対処できるようにする
    if (composeTab) {
      try {
        await api.windows.update(composeTab.windowId, { state: "normal", focused: true });
        error += "（作成ウインドウを開いたままにしています）";
      } catch (e2) {
        console.warn(LOG, "作成ウインドウを戻せなかった", e2);
      }
    }
    return { ok: false, error };
  } finally {
    sending.delete(messageId);
  }
}

// ---------------------------------------------------------------
// 4. パネルからの問い合わせ窓口
// ---------------------------------------------------------------

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;
  if (msg.type === "getInfo") return handleGetInfo(sender);
  if (msg.type === "send" || msg.type === "popout") return handleSend(msg, sender);
  return undefined;
});

// ---------------------------------------------------------------
// 5. 作成ウインドウ → パネル（作成ウインドウのツールバーの「パネルに戻す」）
// ---------------------------------------------------------------

// ボタンに短い注意を出す（作成ウインドウには通知欄が無いため、バッジと説明文で知らせる）
async function flagComposeAction(tabId, title) {
  try {
    await api.composeAction.setBadgeText({ tabId, text: "×" });
    await api.composeAction.setTitle({ tabId, title });
  } catch (e) {
    console.warn(LOG, "ボタンへ注意を出せなかった", e);
  }
}

// 宛先の配列をパネルの入力形式（カンマ区切り）にする。連絡先の参照など文字列でないものは除く
function joinRecipients(list) {
  const items = Array.isArray(list) ? list : list ? [list] : [];
  return items.filter((item) => typeof item === "string").join(", ");
}

api.composeAction.onClicked.addListener(async (tab) => {
  try {
    const details = await api.compose.getComposeDetails(tab.id);
    if (!details.relatedMessageId) {
      await flagComposeAction(tab.id, "返信の作成ウインドウでのみ使えます");
      return;
    }
    const header = await api.messages.get(details.relatedMessageId);

    // 本文は文字だけを移す（書式・添付は移せない）。署名は送信時に付け直されるので外す
    let text = (details.plainTextBody ?? "").replace(/\r\n?/g, "\n");
    const at = text.lastIndexOf("\n-- \n");
    if (at >= 0) text = text.slice(0, at);
    text = text.replace(/\s+$/, "");

    // パネルの下書きとして保存する。表示中のパネルはこの保存を検知して開く
    await api.storage.local.set({
      [`draft:${header.id}`]: {
        text,
        hasQuote: true, // 引用は本文に含まれている。送信時に付け足さない
        replyAll: false,
        to: joinRecipients(details.to),
        cc: joinRecipients(details.cc),
        bcc: joinRecipients(details.bcc),
        identityId: details.identityId ?? "",
        subject: details.subject ?? "",
        headerMessageId: header.headerMessageId ?? "",
        fromWindow: true,
        savedAt: Date.now(),
      },
    });
    console.log(LOG, "作成ウインドウの内容をパネルへ移した", header.id);
    await api.windows.remove(tab.windowId);
  } catch (e) {
    console.error(LOG, "パネルへ戻せなかった", e);
    await flagComposeAction(tab.id, `パネルへ戻せませんでした：${errorText(e)}`);
  }
});
