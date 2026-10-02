// replyfold 背景スクリプト：パネルの登録／メール情報の返答／返信の送信／下書きフォルダーとの同期
"use strict";

const api = globalThis.messenger ?? globalThis.browser;
const SCRIPT_ID = "replyfold-panel";
const LOG = "[replyfold]";
const ALARM = "replyfold-flush";

// 設定の初期値（panel.js の settings と揃える）
const DEFAULT_SETTINGS = {
  includeOriginal: true,
  showInEditor: false,
  quoteMark: true,
  showBcc: false,
  panelHeight: null,
  folderSave: true, // Thunderbird の下書きフォルダーにも保存する
  saveTiming: "leave", // leave＝メールを移る・畳むとき／minimize＝最小化したとき／interval＝一定間隔
  intervalMin: 5,
  replaceOld: "keep", // 差し替えた古い下書き：keep＝下書きフォルダーに残す／move＝指定フォルダーへ移す
  replaceFolder: "", // move の移動先。空ならその下書きのアカウントのごみ箱
  // 下書きの保存先：mail＝表示中のメールのアカウントの下書きフォルダー／sender＝差出人の設定どおり（Thunderbird 標準）
  draftPlace: "mail",
};

async function getSettings() {
  try {
    const stored = await api.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...(stored && stored.settings) };
  } catch (e) {
    console.warn(LOG, "設定を読めなかった（初期値で続行）", e);
    return { ...DEFAULT_SETTINGS };
  }
}

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

// 起動・導入時の準備：作成ウインドウとの対応表は前回のタブを指すので捨て、自動保存の予定を入れ直し、
// 前回の終了までに下書きフォルダーへ反映できなかった下書きを反映する
async function prepare() {
  await registerPanel();
  await injectIntoOpenTabs();
  try {
    await api.storage.local.remove("composeLinks");
  } catch (e) {
    console.warn(LOG, "作成ウインドウとの対応表を消せなかった", e);
  }
  await updateAlarm();
  queued(() => flushAll(false));
}

// 既存タブへの差し込みは、導入・更新時と起動時だけ（再開のたびに CSS を重ねないため）
api.runtime.onInstalled.addListener(prepare);
api.runtime.onStartup.addListener(prepare);

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
  // 下書き・テンプレート・送信待ちのメールにはパネルを出さない（下書きは下書きでしかなく、返信の対象ではない）
  if (["drafts", "templates", "outbox"].some((use) => hasUse(header, use))) return null;
  // 下書きフォルダーとの突き合わせは待たずに返す（結果は保存領域の変化としてパネルへ届く）
  queued(() => reconcile(header));
  return {
    from: await fromChoices(header),
    id: header.id,
    // 下書きの保存キー。Message-ID は再起動やフォルダー移動でも変わらないので、これを基準にする
    suffix: suffixOf(header.headerMessageId, header.id),
    author: header.author ?? "",
    subject: header.subject ?? "",
    headerMessageId: header.headerMessageId ?? "",
    // 引用の見出し行（「On 日時, 名前 wrote:」）に使う受信日時
    date: header.date instanceof Date ? header.date.getTime() : null,
    defaults: await replyDefaults(header),
  };
}

// ---------------------------------------------------------------
// 3. 作成ウインドウの組み立てと送信
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
  return whenReady(
    () => api.compose.sendMessage(tabId, { mode: "sendNow" }),
    timeoutMs,
    // 待っても送信できないままのとき。いちばん多い原因はオフライン作業（送信ボタンが「後で送信」になる）
    "作成ウインドウが送信できる状態になりませんでした。Thunderbird がオフライン作業になっていないか確認してください"
  );
}

// 下書き保存も送信と同じ「準備中」の判定を通るので、同じように待って保存し直す
async function saveWhenReady(tabId, timeoutMs = 8000) {
  return whenReady(
    () => api.compose.saveMessage(tabId, { mode: "draft" }),
    timeoutMs,
    "作成ウインドウが下書きを保存できる状態になりませんでした"
  );
}

// 下書きを保存し、下書きフォルダーに現れるまで待ってから返す。
// saveMessage の結果には、保存先のフォルダーに登録し終えた下書きしか入らない（IMAP では書き込みが後から終わり、空で返ることがある）。
// 作成ウインドウを閉じるのは、下書きが実際に現れてから（書き込みの途中で閉じないため）。
// before＝保存前から下書きフォルダーにあった下書きの id（新しくできた1通を見分けるため）
async function saveDraftAndWait(tabId, orig, before, timeoutMs = 30000) {
  // saveMessage は下書きを組み立て終えた時点で返り、保存先（IMAP サーバー）への書き込みはその後に続く。
  // 書き込みが終わると Thunderbird は「変更あり」の印を外すので、印を立ててから保存し、外れるまで待つ。
  // 外れる前に作成ウインドウを閉じると、書き込みが取り消されて下書きが残らない
  await api.compose.setComposeDetails(tabId, { isModified: true });
  const saved = await saveWhenReady(tabId);
  await waitUntilStored(tabId, timeoutMs);
  const direct = saved?.messages?.[0];
  console.log(LOG, "下書きを保存", { direct: direct ? direct.id : null, folder: direct?.folder?.path });
  if (direct) return direct;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const found = await newReplyDraft(orig, before);
    if (found) {
      console.log(LOG, "下書きフォルダーに現れた", { id: found.id, folder: found.folder?.path });
      return found;
    }
  }
  throw new Error("下書きを保存しましたが、下書きフォルダーで確認できませんでした");
}

async function waitUntilStored(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const details = await api.compose.getComposeDetails(tabId);
    if (!details.isModified) return;
    if (Date.now() >= deadline) {
      const error = new Error("下書きの保存先への書き込みが終わりませんでした（ネットワークを確認してください）");
      error.keepWindow = true; // 閉じると書き込みが取り消されるので、作成ウインドウは残す
      throw error;
    }
    await sleep(300);
  }
}

async function draftIdsSnapshot() {
  const folderId = await draftFolderIds();
  if (!folderId.length) return new Set();
  try {
    return new Set((await queryAll({ folderId }, 1000)).map((h) => h.id));
  } catch (e) {
    console.warn(LOG, "下書きフォルダーの一覧を取れなかった", e);
    return new Set();
  }
}

// 保存前に無かった下書きのうち、元メールへの返信になっているもの
async function newReplyDraft(orig, before) {
  const folderId = await draftFolderIds();
  if (!folderId.length) return null;
  let list = [];
  try {
    list = await queryAll({ folderId }, 1000);
  } catch {
    return null;
  }
  const fresh = list.filter((h) => !before.has(h.id)).sort((a, b) => dateMs(b) - dateMs(a));
  for (const hdr of fresh) {
    if (!orig.headerMessageId || (await parentMid(hdr.id)) === orig.headerMessageId) return hdr;
  }
  return null;
}

async function whenReady(action, timeoutMs, timeoutMessage) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await action();
    } catch (e) {
      const notReady = /not ready/i.test(errorText(e));
      if (!notReady) throw e;
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await sleep(250);
    }
  }
}

// 拡張が裏で開いた作成ウインドウ。保存・送信の通知を「ユーザーの操作」と取り違えないために覚えておく
const ourTabs = new Set();

// 標準の返信作成を開く。minimize なら開いてすぐ最小化する（失敗しても続行）
async function openCompose({ messageId, replyAll, identityId, minimize }) {
  const tab = await api.compose.beginReply(
    messageId,
    replyAll ? "replyToAll" : "replyToSender",
    identityId ? { identityId } : undefined
  );
  if (minimize) {
    ourTabs.add(tab.id);
    try {
      await api.windows.update(tab.windowId, { state: "minimized" });
    } catch (e) {
      console.warn(LOG, "作成ウインドウの最小化に失敗（続行）", e);
    }
  }
  return tab;
}

// 差出人をそろえてから、本文・宛先・件名を差し込む。
// 先に差出人を変えるのは、差出人ごとに署名が入れ替わるため。
// bcc は配列なら上書き、null なら触らない（アカウント設定の自動 Bcc を生かす）
async function fillCompose(tab, { identityId, text, quote, to, cc, bcc, subject }) {
  let details = await api.compose.getComposeDetails(tab.id);
  if (identityId && details.identityId !== identityId) {
    await api.compose.setComposeDetails(tab.id, { identityId });
    details = await api.compose.getComposeDetails(tab.id);
    if (details.identityId !== identityId) throw new Error("差出人を切り替えられませんでした");
  }
  // 形式に合わせて本文を作り直す。片方だけ渡す（形式は途中で変えられないため）
  const update = details.isPlainText
    ? { plainTextBody: buildPlain(details.plainTextBody, text, quote) }
    : { body: buildHtml(details.body, text, quote) };
  update.to = to;
  update.cc = cc;
  if (Array.isArray(bcc)) update.bcc = bcc;
  if (subject) update.subject = subject;
  await api.compose.setComposeDetails(tab.id, update);
}

// 下書きの添付を作成ウインドウへ付け直す（パネルは添付を扱えないので、元の下書きから引き継ぐ）
async function copyAttachments(fromMessageId, tabId) {
  let count = 0;
  let list = [];
  try {
    list = await api.messages.listAttachments(fromMessageId);
  } catch (e) {
    console.warn(LOG, "添付の一覧を取得できなかった", e);
    return 0;
  }
  for (const att of list) {
    try {
      const file = await api.messages.getAttachmentFile(fromMessageId, att.partName);
      await api.compose.addAttachment(tabId, { file, name: att.name });
      count++;
    } catch (e) {
      console.warn(LOG, "添付を引き継げなかった", att.name, e);
    }
  }
  return count;
}

async function closeCompose(tab) {
  try {
    await api.windows.remove(tab.windowId);
  } catch (e) {
    console.warn(LOG, "作成ウインドウを閉じられなかった", e);
  }
  ourTabs.delete(tab.id);
}

const sending = new Set(); // 同じメールへの二重送信を防ぐ

async function handleSend(msg, sender) {
  const messageId = msg.messageId;
  const suffix = validSuffix(msg.suffix);
  const text = typeof msg.text === "string" ? msg.text.replace(/\r\n?/g, "\n") : "";
  const replyAll = msg.replyAll === true;

  const to = uniqueAddresses(splitAddresses(msg.to));
  const cc = uniqueAddresses(splitAddresses(msg.cc));
  const bcc = uniqueAddresses(splitAddresses(msg.bcc));
  const subject = typeof msg.subject === "string" ? msg.subject.trim() : "";
  const quote = cleanQuote(msg.quote);
  const identityId = typeof msg.identityId === "string" ? msg.identityId : "";

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
    // ① 標準の返信作成を開く。送信なら最小化し、別ウインドウへ引き継ぐときは見せたままにする
    console.log(LOG, "① 返信作成を開く", { messageId, replyAll, popout });
    composeTab = await openCompose({ messageId, replyAll, identityId, minimize: !popout });

    // ② 本文・宛先・件名を差し込む。Bcc 欄を隠しているときは Bcc に触らない
    await fillCompose(composeTab, {
      identityId,
      text,
      quote,
      to,
      cc,
      bcc: typeof msg.bcc === "string" ? bcc : null,
      subject,
    });
    console.log(LOG, "② 本文・宛先・件名を差し込み", { to: to.length, cc: cc.length });

    if (popout) {
      // 下書きフォルダーの下書きと紐づいていれば、添付を引き継ぎ、この作成ウインドウの保存を同じ1通の更新として扱う
      const settings = await getSettings();
      if (suffix && settings.folderSave) {
        const { link } = await readPair(suffix);
        if (link?.draftId && link.attachments) {
          const old = await findMessage(link.draftId, link.draftMid, "drafts");
          if (old) await copyAttachments(old.id, composeTab.id);
        }
      }
      // この対応がある間、パネルは「別ウインドウで編集中」としてロックされる
      if (suffix) await setComposeLink(composeTab.id, suffix);
      return { ok: true };
    }

    // ③ 即時送信（準備中なら待って送り直す）
    const result = await sendWhenReady(composeTab.id);
    console.log(LOG, "③ 送信完了", result?.mode, result?.headerMessageId);
    // ourTabs からはウインドウが閉じたとき（tabs.onRemoved）に外す。送信の通知より先に外すと、ユーザーの送信と取り違えるため
    // 送った返信の下書きは役目を終えたので、紐付けを外してごみ箱へ
    if (suffix) await queued(() => discardDraft(suffix)).catch(() => {});
    return { ok: true };
  } catch (e) {
    console.error(LOG, "送信に失敗", e);
    let error = errorText(e);
    // 作成ウインドウを戻し、ユーザーが手で対処できるようにする
    if (composeTab) {
      ourTabs.delete(composeTab.id);
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

function cleanQuote(quote) {
  return quote && typeof quote.body === "string" && quote.body.trim()
    ? {
        header: String(quote.header ?? ""),
        body: quote.body.replace(/\r\n?/g, "\n"),
        mark: quote.mark !== false,
      }
    : null;
}

// ---------------------------------------------------------------
// 4. 下書き（拡張の保存領域 ⇔ Thunderbird の下書きフォルダー）
// ---------------------------------------------------------------
//
// 1通のメールにつき下書きは1通。保存領域には2つのキーを持つ。
//   draft:<suffix>  入力内容（パネルが書く）。text・宛先・件名・差出人・引用・savedAt など
//   link:<suffix>   下書きフォルダーの下書きとの紐付け（背景スクリプトだけが書く）
//                   draftId・draftMid（下書きメールの id と Message-ID）、syncedAt（反映した入力の savedAt）、
//                   attachments（添付数）、formatted（書式付きか）、pending（差し替え候補）、ignored（聞かない下書き）
// suffix は元メールの Message-ID（無いメールだけメールID）。
// 入力内容の savedAt が syncedAt より新しい＝下書きフォルダーへ未反映。

function suffixOf(headerMessageId, id) {
  return headerMessageId ? `mid:${headerMessageId}` : `id:${id}`;
}
const draftKeyOf = (suffix) => `draft:${suffix}`;
const linkKeyOf = (suffix) => `link:${suffix}`;

function validSuffix(value) {
  return typeof value === "string" && /^(mid|id):./.test(value) ? value : null;
}

async function readPair(suffix) {
  const dk = draftKeyOf(suffix);
  const lk = linkKeyOf(suffix);
  const got = await api.storage.local.get([dk, lk]);
  return { content: got?.[dk] ?? null, link: got?.[lk] ?? null };
}

async function writeLink(suffix, link) {
  await api.storage.local.set({ [linkKeyOf(suffix)]: link });
}

async function removePair(suffix) {
  await api.storage.local.remove([draftKeyOf(suffix), linkKeyOf(suffix)]);
}

function isDirty(content, link) {
  if (!content) return false;
  return !link || !link.draftId || (link.syncedAt ?? 0) < (content.savedAt ?? 0);
}

// 下書きの処理は1本の列に並べて順に行う（同じ下書きを同時に保存・削除しないため）。
// 列の中から queued を呼ぶと詰まるので、列の中では関数を直接呼ぶ
let chain = Promise.resolve();
function queued(task) {
  const run = chain.then(task);
  chain = run.catch((e) => console.error(LOG, "下書きの処理に失敗", e));
  return run;
}

// 旧形式（draft:<メールID>）の下書きを、Message-ID 基準のキーへ移す。消さずに中身を引き継ぐ
async function migrateDrafts() {
  const all = await api.storage.local.get(null);
  const updates = {};
  const olds = [];
  for (const [key, value] of Object.entries(all ?? {})) {
    const m = /^draft:(\d+)$/.exec(key);
    if (!m) continue;
    const next = draftKeyOf(suffixOf(value?.headerMessageId, m[1]));
    if (!(next in all) && !(next in updates)) updates[next] = { ...value, origId: Number(m[1]) };
    olds.push(key);
  }
  if (!olds.length) return;
  await api.storage.local.set(updates);
  await api.storage.local.remove(olds);
  console.log(LOG, "下書きを新しいキーへ移した", olds.length);
}

// 作成ウインドウ（タブ）と下書きの対応表。背景スクリプトが休止しても失わないよう保存領域に置く。
// 値が suffix＝紐づいた下書きの編集、"?suffix"＝差し替え候補の下書きの編集
async function getComposeLinks() {
  const got = await api.storage.local.get("composeLinks");
  return got?.composeLinks ?? {};
}

async function isEditingInWindow(suffix) {
  return Object.values(await getComposeLinks()).includes(suffix);
}

// パネルの［ウインドウを表示］：その下書きを編集中の作成ウインドウを前に出す
async function focusCompose(suffix) {
  const links = await getComposeLinks();
  const tabId = Object.keys(links).find((key) => links[key] === suffix);
  if (!tabId) return { ok: false, error: "編集中のウインドウが見つかりませんでした" };
  const tab = await api.tabs.get(Number(tabId));
  const win = await api.windows.get(tab.windowId);
  await api.windows.update(tab.windowId, win.state === "minimized" ? { state: "normal", focused: true } : { focused: true });
  return { ok: true };
}

// 読んで書き戻すので、同時に呼ばれても書き込みを取りこぼさないよう順に行う
let linkChain = Promise.resolve();
function setComposeLink(tabId, value) {
  const run = linkChain.then(async () => {
    const links = await getComposeLinks();
    if (value) links[tabId] = value;
    else if (tabId in links) delete links[tabId];
    else return;
    await api.storage.local.set({ composeLinks: links });
  });
  linkChain = run.catch(() => {});
  return run;
}

// ---- メールの検索 ----

async function getMessage(id) {
  if (id === undefined || id === null) return null;
  try {
    return await api.messages.get(id);
  } catch {
    return null;
  }
}

async function queryAll(queryInfo, limit) {
  const out = [];
  let page = await api.messages.query(queryInfo);
  while (page) {
    out.push(...(page.messages ?? []));
    if (!page.id || out.length >= limit) break;
    page = await api.messages.continueList(page.id);
  }
  return out;
}

const hasUse = (hdr, use) => !!hdr?.folder?.specialUse?.includes(use);

// id で引き、Message-ID が合わなければ Message-ID で探し直す（id は再起動や移動で変わるため）。
// where：drafts＝下書きフォルダーにあるものだけ／original＝下書き・ごみ箱以外を優先
async function findMessage(id, mid, where) {
  const fits = (h) =>
    where === "drafts" ? hasUse(h, "drafts") : where === "original" ? !hasUse(h, "drafts") : true;
  const hit = await getMessage(id);
  if (hit && (!mid || hit.headerMessageId === mid) && fits(hit)) return hit;
  if (!mid) return null;
  let list = [];
  try {
    list = await queryAll({ headerMessageId: mid }, 20);
  } catch (e) {
    console.warn(LOG, "Message-ID で探せなかった", e);
  }
  if (where === "original") return list.find((h) => fits(h) && !hasUse(h, "trash")) ?? list.find(fits) ?? null;
  return list.find(fits) ?? null;
}

function resolveOrig(content) {
  return findMessage(content.origId, content.headerMessageId, "original");
}

// 下書きが返信している元メールの Message-ID（In-Reply-To、無ければ References の最後）
const parentCache = new Map();
async function parentMid(messageId) {
  if (parentCache.has(messageId)) return parentCache.get(messageId);
  let mid = null;
  try {
    const full = await api.messages.getFull(messageId);
    const headers = full?.headers ?? {};
    const ids = (line) => [...String(line ?? "").matchAll(/<([^>]+)>/g)].map((m) => m[1]);
    const inReplyTo = ids((headers["in-reply-to"] ?? []).join(" "));
    const refs = ids((headers["references"] ?? []).join(" "));
    mid = inReplyTo[0] ?? refs[refs.length - 1] ?? null;
  } catch (e) {
    console.warn(LOG, "下書きの返信先を読めなかった", e);
  }
  parentCache.set(messageId, mid);
  return mid;
}

async function origOfDraft(draftHdr) {
  const mid = await parentMid(draftHdr.id);
  return mid ? findMessage(null, mid, "original") : null;
}

async function draftFolderIds() {
  try {
    const list = await api.folders.query({ specialUse: ["drafts"] });
    return list.map((f) => f.id);
  } catch (e) {
    console.warn(LOG, "下書きフォルダーを取得できなかった", e);
    return [];
  }
}

const dateMs = (hdr) => (hdr?.date ? new Date(hdr.date).getTime() || 0 : 0);

// 件名の先頭の「Re:」などを外す（下書きの候補を件名で絞り込むため）
function baseSubject(subject) {
  return String(subject ?? "")
    .replace(/^\s*((re|fwd?|aw|sv|tr)\s*(\[\d+\])?\s*[:：]\s*)+/i, "")
    .trim();
}

// 元メールへの返信になっている下書きを、新しい順に返す。
// 件名で候補を絞ってから、In-Reply-To で本当に返信かを確かめる（全下書きの中身を読まないため）
async function findReplyDrafts(orig) {
  if (!orig.headerMessageId) return [];
  const folderId = await draftFolderIds();
  if (!folderId.length) return [];
  const query = { folderId };
  const base = baseSubject(orig.subject);
  if (base) query.subject = base;
  let list = [];
  try {
    list = await queryAll(query, 200);
  } catch (e) {
    console.warn(LOG, "下書きを検索できなかった", e);
    return [];
  }
  const out = [];
  for (const hdr of list) {
    if ((await parentMid(hdr.id)) === orig.headerMessageId) out.push(hdr);
  }
  return out.sort((a, b) => dateMs(b) - dateMs(a));
}

// ---- 移動・削除 ----

async function trashFolderId(accountId) {
  if (!accountId) return null;
  try {
    const list = await api.folders.query({ accountId, specialUse: ["trash"] });
    return list[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ごみ箱へ移す（取り戻せるように完全には消さない）
async function moveToTrash(hdr) {
  const trash = await trashFolderId(hdr.folder?.accountId);
  if (trash) await api.messages.move([hdr.id], trash);
  else await api.messages.delete([hdr.id]); // ごみ箱が見つからないときはアカウント設定に従う
}

// 下書きを、元メールのあるアカウントの下書きフォルダーへ移す（設定が mail のとき）。
// Thunderbird は差出人ごとの下書きフォルダーに保存するため、受け取ったアカウントと別の場所に入ることがある。
// 移した先の下書き（id が変わる）を返す。移さなかった・見つからなかったときは元の hdr を返す
async function relocateDraft(hdr, orig) {
  const settings = await getSettings();
  const accountId = orig?.folder?.accountId;
  if (settings.draftPlace !== "mail" || !accountId || hdr.folder?.accountId === accountId) {
    console.log(LOG, "下書きは移さない", { place: settings.draftPlace, account: accountId, saved: hdr.folder?.accountId });
    return hdr;
  }
  let target = null;
  try {
    target = (await api.folders.query({ accountId, specialUse: ["drafts"] }))[0]?.id ?? null;
  } catch (e) {
    console.warn(LOG, "移し先の下書きフォルダーを取得できなかった", e);
  }
  if (!target) return hdr;
  await api.messages.move([hdr.id], target);
  // 移した先で Message-ID から探し直す（IMAP では少し遅れて現れる）
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const list = await queryAll({ folderId: target, headerMessageId: hdr.headerMessageId }, 5).catch(() => []);
    if (list[0]) {
      console.log(LOG, "下書きを表示中のアカウントへ移した", {
        id: list[0].id,
        account: accountId,
        folder: list[0].folder?.path,
        from: hdr.folder?.accountId,
      });
      return list[0];
    }
    await sleep(500);
  }
  console.warn(LOG, "移した下書きをまだ確認できない（Message-ID で後から辿る）");
  return hdr;
}

// 作成ウインドウで編集していた下書きを、ウインドウが閉じてから移す
// （開いている間に移すと、ウインドウ側の保存し直しで古い版が残るため）
async function relocateLinked(suffix) {
  const { link } = await readPair(suffix);
  if (!link?.draftId) return;
  const draft = await findMessage(link.draftId, link.draftMid, "any");
  if (!draft) return;
  const orig = await origOfSuffix(suffix);
  const moved = await relocateDraft(draft, orig);
  if (moved.id !== draft.id) {
    const latest = (await readPair(suffix)).link ?? link;
    await writeLink(suffix, { ...latest, draftId: moved.id, draftMid: moved.headerMessageId });
  }
  await sweepVersions(suffix);
}

// 差し替えた古い下書きを、設定で選んだフォルダーへ移す。フォルダーが無くなっていればごみ箱へ
async function moveOld(hdr, folderId) {
  if (folderId) {
    try {
      await api.messages.move([hdr.id], folderId);
      return;
    } catch (e) {
      console.warn(LOG, "指定のフォルダーへ移せなかった（ごみ箱へ移す）", e);
    }
  }
  await moveToTrash(hdr);
}

// 同じ下書きの過去の版（この拡張が作った Message-ID）を覚えておく。最大10件
function nextVersions(link, newMid) {
  const all = [...(link?.versions ?? []), link?.draftMid].filter((mid) => mid && mid !== newMid);
  return [...new Set(all)].slice(-10);
}

// 過去の版が下書きフォルダーに残っていれば消す。
// id は移動や IMAP の同期で変わり、古い id では消し損ねることがあるので、Message-ID で探して確実に消す
async function sweepVersions(suffix) {
  const { link } = await readPair(suffix);
  if (!link?.versions?.length) return;
  for (const mid of link.versions) {
    if (mid === link.draftMid) continue;
    let list = [];
    try {
      list = await queryAll({ headerMessageId: mid }, 10);
    } catch {
      continue;
    }
    for (const hdr of list) {
      if (hasUse(hdr, "drafts") && hdr.headerMessageId !== link.draftMid) {
        console.log(LOG, "古い版の下書きを消す", { id: hdr.id, folder: hdr.folder?.path });
        await deleteVersion(hdr);
      }
    }
  }
}

// 保存し直して古くなった版を消す。中身は新しい版に引き継いでいるので、ごみ箱を経由させない
// （Thunderbird 自身も下書きを保存し直すときは古い版を消す）
async function deleteVersion(hdr) {
  try {
    await api.messages.delete([hdr.id], { deletePermanently: true });
  } catch (e) {
    console.warn(LOG, "古い版の下書きを消せなかった", e);
  }
}

// ---- 下書きメールの中身を読む ----

// 書式とみなす要素。引用・署名の中は元メールや署名の書式なので数えない
const FORMAT_SELECTOR =
  "b,strong,i,em,u,s,strike,font,a[href],img,ul,ol,table,h1,h2,h3,h4,h5,h6,code,sub,sup,[style],[color],[bgcolor]";

function parseHtml(html) {
  return new DOMParser().parseFromString(html ?? "", "text/html");
}

function hasFormatting(doc) {
  return [...doc.body.querySelectorAll(FORMAT_SELECTOR)].some(
    (node) => !node.closest("blockquote[type='cite'], .moz-cite-prefix, .moz-signature")
  );
}

// HTML を文字にする。改行は br と段落で、引用ブロックは各行に「> 」を付ける
function htmlToText(doc) {
  for (const node of doc.querySelectorAll(".moz-signature, style, script, title")) node.remove();
  const BLOCK = /^(P|DIV|PRE|UL|OL|LI|TABLE|TR|H[1-6])$/;
  const nl = (s) => (s && !s.endsWith("\n") ? `${s}\n` : s);
  function walk(node, pre) {
    let s = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const value = child.nodeValue.replace(/ /g, " ");
        s += pre ? value : value.replace(/\s+/g, " ");
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === "BR") s += "\n";
        else if (tag === "BLOCKQUOTE") {
          const inner = walk(child, pre).replace(/^\n+|\n+$/g, "");
          s = nl(s) + inner.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n") + "\n";
        } else if (BLOCK.test(tag)) {
          s = nl(nl(s) + walk(child, pre || tag === "PRE"));
        } else s += walk(child, pre);
      }
    }
    return s;
  }
  return walk(doc.body, false)
    .split("\n")
    .map((line) => line.replace(/^ +| +$/g, ""))
    .join("\n");
}

function stripPlainSignature(text) {
  const at = text.lastIndexOf("\n-- \n");
  return at >= 0 ? text.slice(0, at) : text;
}

async function identityOf(author) {
  const email = emailOf(author);
  try {
    const identities = await api.identities.list();
    return identities.find((i) => (i.email || "").toLowerCase() === email)?.id ?? "";
  } catch {
    return "";
  }
}

const joinList = (list) => (Array.isArray(list) ? list.join(", ") : "");

// 下書きメールから、パネルの入力内容を作る。引用は本文に含まれているものとして扱う
async function contentFromDraft(draftHdr, orig) {
  let text = "";
  let formatted = false;
  try {
    const parts = await api.messages.listInlineTextParts(draftHdr.id);
    const html = parts.find((p) => /html/i.test(p.contentType));
    const plain = parts.find((p) => /plain/i.test(p.contentType));
    if (html) {
      const doc = parseHtml(html.content);
      formatted = hasFormatting(doc);
      text = htmlToText(doc);
    } else if (plain) {
      text = stripPlainSignature(plain.content.replace(/\r\n?/g, "\n"));
    }
  } catch (e) {
    console.warn(LOG, "下書きの本文を読めなかった", e);
  }
  let attachments = 0;
  try {
    attachments = (await api.messages.listAttachments(draftHdr.id)).length;
  } catch (e) {
    console.warn(LOG, "下書きの添付を数えられなかった", e);
  }
  const bccList = draftHdr.bccList ?? [];
  return {
    content: {
      text: text.replace(/^\n+/, "").replace(/\s+$/, ""),
      hasQuote: true,
      quote: null,
      replyAll: false,
      to: joinList(draftHdr.recipients),
      cc: joinList(draftHdr.ccList),
      bcc: joinList(bccList),
      bccShown: bccList.length > 0,
      identityId: await identityOf(draftHdr.author),
      subject: draftHdr.subject ?? "",
      headerMessageId: orig.headerMessageId ?? "",
      origId: orig.id,
      savedAt: Date.now(),
      external: true, // 表示中のパネルへ「入力中の内容をこれに置き換える」合図
    },
    attachments,
    formatted,
  };
}

// 下書きメールを、このメールの下書きとして紐付け、パネルの入力内容にする
async function adopt(suffix, draftHdr, orig, prevLink) {
  const r = await contentFromDraft(draftHdr, orig);
  await writeLink(suffix, {
    draftId: draftHdr.id,
    draftMid: draftHdr.headerMessageId,
    syncedAt: r.content.savedAt,
    attachments: r.attachments,
    formatted: r.formatted,
    pending: null,
    ignored: prevLink?.ignored ?? [],
    versions: prevLink?.versions ?? [], // 同じ下書きの更新のときだけ、呼び出し側が過去の版を渡す
  });
  await api.storage.local.set({ [draftKeyOf(suffix)]: r.content });
}

// ---- 下書きフォルダーへの保存 ----

// パネルの入力内容を下書きフォルダーへ反映する。最小化した作成ウインドウで保存し、古い版を消す
async function saveToFolder(suffix) {
  const settings = await getSettings();
  if (!settings.folderSave || !suffix) return false;
  // 作成ウインドウで編集中の下書きには触らない（ウインドウ側の保存とぶつかるため）
  if (await isEditingInWindow(suffix)) return false;
  const { content, link } = await readPair(suffix);
  if (!isDirty(content, link)) return false;
  const old = link?.draftId ? await findMessage(link.draftId, link.draftMid, "drafts") : null;

  // パネルで本文を空にした＝下書きを片付けた
  if (content.empty) {
    if (old) await moveToTrash(old);
    await removePair(suffix);
    return true;
  }

  const orig = await resolveOrig(content);
  if (!orig) {
    console.warn(LOG, "元メールが見つからないため下書きフォルダーへ保存できない", suffix);
    return false;
  }
  console.log(LOG, "下書きフォルダーへの保存を開始", suffix);
  const tab = await openCompose({
    messageId: orig.id,
    replyAll: content.replyAll === true,
    identityId: content.identityId,
    minimize: true,
  });
  try {
    await fillCompose(tab, {
      identityId: content.identityId,
      text: content.text ?? "",
      quote: content.hasQuote ? null : cleanQuote(content.quote),
      to: uniqueAddresses(splitAddresses(content.to)),
      cc: uniqueAddresses(splitAddresses(content.cc)),
      bcc: content.bccShown ? uniqueAddresses(splitAddresses(content.bcc)) : null,
      subject: (content.subject ?? "").trim(),
    });
    const attachments = old && link.attachments ? await copyAttachments(old.id, tab.id) : 0;
    const before = await draftIdsSnapshot();
    const savedHdr = await saveDraftAndWait(tab.id, orig, before);
    await closeCompose(tab);
    const hdr = await relocateDraft(savedHdr, orig).catch((e) => {
      console.warn(LOG, "下書きを表示中のアカウントへ移せなかった", e);
      return savedHdr;
    });
    if (old && old.id !== hdr.id) await deleteVersion(old);
    const latest = (await readPair(suffix)).link ?? link ?? {};
    await writeLink(suffix, {
      ...latest,
      draftId: hdr.id,
      draftMid: hdr.headerMessageId,
      versions: nextVersions(latest, hdr.headerMessageId),
      syncedAt: content.savedAt,
      attachments,
      formatted: false, // パネルの文字で保存し直したので書式は無い
    });
    await sweepVersions(suffix);
    console.log(LOG, "下書きフォルダーへ保存", suffix);
    return true;
  } catch (e) {
    if (e?.keepWindow) {
      // 書き込み中のまま閉じると下書きが失われる。見える状態に戻して、ユーザーの手に委ねる
      ourTabs.delete(tab.id);
      await api.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
    } else {
      await closeCompose(tab);
    }
    throw e;
  }
}

// いま表示中のメールの suffix（「メールを移るとき」の保存で、表示中のものを除くため）
async function displayedSuffixes() {
  const out = new Set();
  try {
    const tabs = await api.tabs.query({ type: ["mail", "messageDisplay"] });
    for (const tab of tabs) {
      const list = await api.messageDisplay.getDisplayedMessages(tab.id).catch(() => null);
      const m = list?.messages?.length === 1 ? list.messages[0] : null;
      if (m) out.add(suffixOf(m.headerMessageId, m.id));
    }
  } catch (e) {
    console.warn(LOG, "表示中のメールを確かめられなかった", e);
  }
  return out;
}

// 未反映の下書きをまとめて下書きフォルダーへ。exceptDisplayed なら表示中のメールの分は後回し
async function flushAll(exceptDisplayed) {
  const settings = await getSettings();
  if (!settings.folderSave) return;
  const all = await api.storage.local.get(null);
  const skip = exceptDisplayed ? await displayedSuffixes() : new Set();
  for (const [key, content] of Object.entries(all ?? {})) {
    if (!key.startsWith("draft:")) continue;
    const suffix = key.slice("draft:".length);
    if (skip.has(suffix) || !isDirty(content, all[linkKeyOf(suffix)])) continue;
    // 失敗した下書きは5分おく（作成ウインドウが開いては閉じる、を繰り返さないため）
    if (Date.now() - (failedAt.get(suffix) ?? 0) < 5 * 60 * 1000) continue;
    try {
      await saveToFolder(suffix);
      failedAt.delete(suffix);
    } catch (e) {
      failedAt.set(suffix, Date.now());
      console.warn(LOG, "下書きフォルダーへ保存できなかった", suffix, e);
    }
  }
}
const failedAt = new Map();

// ---- メールを開いたときの突き合わせ ----

// 紐づいた下書きが今も下書きフォルダーにあるかを確かめ、ほかの下書き（標準の返信ボタンで書いたもの）を探す
async function reconcile(orig) {
  const settings = await getSettings();
  if (!settings.folderSave) return;
  const suffix = suffixOf(orig.headerMessageId, orig.id);
  let { content, link } = await readPair(suffix);

  if (link?.draftId) {
    // 下書きフォルダーに無くても、ごみ箱以外にあれば消えたとはみなさない
    // （下書きフォルダーの印が付いていない保存先もありうる。誤って紐付けを外して入力を消さないため）
    let linked = await findMessage(link.draftId, link.draftMid, "drafts");
    if (!linked) {
      const anywhere = await findMessage(link.draftId, link.draftMid, "any");
      if (anywhere && !hasUse(anywhere, "trash")) linked = anywhere;
    }
    if (!linked) {
      // 下書きフォルダーから消えた（手で削除・送信）。未反映の入力があれば新しい下書きとして残し、無ければ紐付けを終える
      if (content && !content.empty && isDirty(content, link)) {
        link = { ...link, draftId: null, draftMid: null, attachments: 0, formatted: false };
        await writeLink(suffix, link);
      } else {
        await removePair(suffix);
        content = null;
        link = null;
      }
    } else {
      if (linked.id !== link.draftId) {
        link = { ...link, draftId: linked.id };
        await writeLink(suffix, link);
      }
      // 入力内容が無い（別ウインドウへ移した後など）ときは、下書きから読み直してパネルに出す
      if (!content) {
        await adopt(suffix, linked, orig, link);
        return;
      }
    }
  }

  const ignored = new Set(link?.ignored ?? []);
  const others = (await findReplyDrafts(orig)).filter(
    (h) => h.headerMessageId !== link?.draftMid && !ignored.has(h.headerMessageId)
  );
  const newest = others[0] ?? null;
  const hasCurrent = !!link?.draftId || !!(content && !content.empty && (content.text ?? "").trim());
  if (!newest) {
    if (link?.pending) await writeLink(suffix, { ...link, pending: null });
    return;
  }
  // 拡張の下書きが無ければ、いちばん新しい1通をそのまま紐付ける。あれば差し替えるかをパネルで聞く
  if (!hasCurrent) {
    await adopt(suffix, newest, orig, link);
    return;
  }
  if (link?.pending?.id !== newest.id) {
    await writeLink(suffix, { ...(link ?? {}), pending: { id: newest.id, mid: newest.headerMessageId } });
  }
}

// ---- パネルからの操作 ----

// 差し替え候補の下書きを最新として紐付ける。今の下書きは先に反映してから、設定に従って残すか移す
async function replaceDraft(suffix) {
  const settings = await getSettings();
  const first = await readPair(suffix);
  if (!first.link?.pending) return { ok: false, error: "差し替える下書きがありません" };
  if (isDirty(first.content, first.link) && !first.content.empty) {
    const saved = await saveToFolder(suffix).catch((e) => {
      console.warn(LOG, "差し替え前の保存に失敗", e);
      return false;
    });
    if (!saved) return { ok: false, error: "今の下書きを保存できなかったため、差し替えを止めました" };
  }
  const { content, link } = await readPair(suffix);
  const pending = await findMessage(link.pending.id, link.pending.mid, "drafts");
  if (!pending) {
    await writeLink(suffix, { ...link, pending: null });
    return { ok: false, error: "差し替える下書きが見つかりませんでした" };
  }
  const orig = (content && (await resolveOrig(content))) || (await origOfDraft(pending));
  if (!orig) return { ok: false, error: "元のメールが見つかりませんでした" };
  const ignored = [...(link.ignored ?? [])];
  const old = link.draftId ? await findMessage(link.draftId, link.draftMid, "drafts") : null;
  if (old && old.id !== pending.id) {
    if (settings.replaceOld === "move") await moveOld(old, settings.replaceFolder);
    else ignored.push(old.headerMessageId); // 下書きフォルダーに残す。以後この1通については聞かない
  }
  await adopt(suffix, pending, orig, { ignored });
  return { ok: true };
}

// 差し替えずに今の下書きを使い続ける。その候補については以後聞かない
async function keepDraft(suffix) {
  const { link } = await readPair(suffix);
  if (!link?.pending) return { ok: true };
  await writeLink(suffix, {
    ...link,
    pending: null,
    ignored: [...(link.ignored ?? []), link.pending.mid].filter(Boolean),
  });
  return { ok: true };
}

// パネルの「破棄」・送信後：紐づいた下書きをごみ箱へ移し、紐付けを終える
async function discardDraft(suffix) {
  const { link } = await readPair(suffix);
  if (link?.draftId) {
    const linked = await findMessage(link.draftId, link.draftMid, "drafts");
    if (linked) await moveToTrash(linked);
  }
  await removePair(suffix);
  return { ok: true };
}

// 設定の「移動先」に出すフォルダーの一覧
async function listFolders() {
  try {
    const [folders, accounts] = await Promise.all([api.folders.query({}), api.accounts.list(false)]);
    const names = new Map(accounts.map((a) => [a.id, a.name]));
    return folders
      .filter((f) => f.accountId && !f.isRoot && !f.isVirtual)
      .map((f) => ({ id: f.id, label: `${names.get(f.accountId) ?? ""} / ${String(f.path ?? f.name).replace(/^\//, "")}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch (e) {
    console.warn(LOG, "フォルダーの一覧を取得できなかった", e);
    return [];
  }
}

// ---- 標準の作成ウインドウで保存・送信されたとき ----

// 作成ウインドウがどのメールへの返信で、紐づいた下書きの編集か（linkedSession）を調べる
// 下書きから開いた作成ウインドウは、一度保存すると開いた元の下書きが消え、relatedMessageId が取れなくなる。
// そのため開いた時点の対応（composeLinks）も手がかりに使う
async function composeTarget(tabId, details, savedHdr) {
  let orig = null;
  const rel = await getMessage(details?.relatedMessageId);
  if (rel && details.type === "reply") orig = rel;
  else if (rel && details.type === "draft") orig = await origOfDraft(rel);
  if (!orig && savedHdr) orig = await origOfDraft(savedHdr);
  const mark = (await getComposeLinks())[tabId];
  if (!orig && mark) orig = await origOfSuffix(mark.replace(/^\?/, ""));
  if (!orig) return null;
  const suffix = suffixOf(orig.headerMessageId, orig.id);
  const { content, link } = await readPair(suffix);
  // 同じメールが複数のアカウントに届いていると、Message-ID からは別アカウントの写しを拾いうる。
  // パネルで最後に書いていた写し（入力内容の origId）を優先する
  if (content) {
    const preferred = await resolveOrig(content);
    if (preferred && preferred.headerMessageId === orig.headerMessageId) orig = preferred;
  }
  // 紐づいた下書きを下書きフォルダーから開いた編集か。id は IMAP の同期で変わるので、Message-ID でも照合する
  const linkedSession =
    mark === suffix ||
    (details?.type === "draft" &&
      !!link?.draftId &&
      (link.draftId === details.relatedMessageId || (!!link.draftMid && rel?.headerMessageId === link.draftMid)));
  return { suffix, orig, content, link, mark, linkedSession };
}

// suffix から元メールを引く（入力内容の origId、無ければ紐づいた下書きの返信先から）
async function origOfSuffix(suffix) {
  const { content, link } = await readPair(suffix);
  if (content) {
    const orig = await resolveOrig(content);
    if (orig) return orig;
  }
  if (link?.draftId || link?.draftMid) {
    const draft = await findMessage(link.draftId, link.draftMid, "any");
    if (draft) return origOfDraft(draft);
  }
  const mid = suffix.startsWith("mid:") ? suffix.slice(4) : null;
  return mid ? findMessage(null, mid, "original") : null;
}

// 作成ウインドウが開いたら、どのメールへの返信かをその時点で覚えておく（後で relatedMessageId が取れなくなっても辿れるように）。
// 別ウインドウで開く（popout）が先に書いた対応は上書きしない
api.tabs.onCreated.addListener(async (tab) => {
  if (tab.type !== "messageCompose" || ourTabs.has(tab.id)) return;
  try {
    const details = await api.compose.getComposeDetails(tab.id);
    if (details.type !== "draft" && details.type !== "reply") return;
    const target = await composeTarget(tab.id, details, null);
    if (!target || target.mark) return;
    await setComposeLink(tab.id, target.linkedSession ? target.suffix : `?${target.suffix}`);
  } catch (e) {
    console.warn(LOG, "作成ウインドウの返信先を覚えられなかった", e);
  }
});

async function onUserSaved(tabId, details, hdr) {
  const settings = await getSettings();
  if (!settings.folderSave) return;
  const target = await composeTarget(tabId, details, hdr);
  if (!target) return;
  const { suffix, orig, content, link, mark, linkedSession } = target;
  const hasCurrent = !!link?.draftId || !!(content && !content.empty && (content.text ?? "").trim());

  if (linkedSession || !hasCurrent || link?.draftMid === hdr.headerMessageId) {
    // 紐づいた下書きの更新（または初めての1通）。古い版が残っていれば消し、パネルの内容も差し替える
    if (link?.draftId && link.draftId !== hdr.id) {
      const old = await findMessage(link.draftId, link.draftMid, "drafts");
      if (old && old.id !== hdr.id) await deleteVersion(old);
    }
    await adopt(suffix, hdr, orig, { ignored: link?.ignored, versions: nextVersions(link, hdr.headerMessageId) });
    await sweepVersions(suffix);
    await setComposeLink(tabId, suffix);
    return;
  }
  // 別の下書き：差し替えるかをパネルで聞く
  if ((link?.ignored ?? []).includes(hdr.headerMessageId)) return;
  await writeLink(suffix, { ...(link ?? {}), pending: { id: hdr.id, mid: hdr.headerMessageId } });
  await setComposeLink(tabId, `?${suffix}`);
}

api.compose.onAfterSave.addListener((tab, info) => {
  if (ourTabs.has(tab.id) || info?.error || info?.mode === "template") return;
  const hdr = info?.messages?.[0];
  if (!hdr) return;
  queued(() => onUserSaved(tab.id, info.details ?? {}, hdr));
});

api.compose.onAfterSend.addListener((tab, info) => {
  if (ourTabs.has(tab.id) || info?.error) return;
  queued(async () => {
    const target = await composeTarget(tab.id, info.details ?? {}, null);
    if (target?.linkedSession) {
      // 紐づいた下書きを作成ウインドウから送った。紐付けを終える
      await discardDraft(target.suffix);
    } else if (target?.mark === `?${target.suffix}` && target.link?.pending) {
      await writeLink(target.suffix, { ...target.link, pending: null });
    }
    await setComposeLink(tab.id, null);
  });
});

// ---- 保存のタイミング ----

// メールを移る・タブを閉じる：少し待ってから（パネルが最後の入力を書き切るのを待つ）、表示から外れた下書きを反映
let leaveTimer = null;
async function onLeave() {
  const settings = await getSettings();
  if (!settings.folderSave || settings.saveTiming !== "leave") return;
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => queued(() => flushAll(true)), 1500);
}
(api.messageDisplay.onMessagesDisplayed ?? api.messageDisplay.onMessageDisplayed)?.addListener(onLeave);
api.tabs.onRemoved.addListener(async (tabId) => {
  // 拡張が裏で開いた作成ウインドウが閉じただけなら、保存の合図にしない（保存の連鎖を防ぐ）
  const ours = ourTabs.delete(tabId);
  const mark = (await getComposeLinks().catch(() => ({})))[tabId];
  await setComposeLink(tabId, null).catch(() => {});
  // 紐づいた下書きを編集していた作成ウインドウが閉じた：ウインドウ側で保存した版を表示中のアカウントへ移す
  if (mark && !mark.startsWith("?")) queued(() => relocateLinked(mark));
  if (!ours) onLeave();
});

// 最小化：メインウインドウが最小化されたら、すべての未反映の下書きを反映
api.windows.onFocusChanged.addListener(async () => {
  if (ourTabs.size) return; // 拡張が作成ウインドウを開いている最中のフォーカス移動は無視
  const settings = await getSettings();
  if (!settings.folderSave || settings.saveTiming !== "minimize") return;
  try {
    const wins = await api.windows.getAll({ windowTypes: ["normal"] });
    if (wins.some((w) => w.state === "minimized")) queued(() => flushAll(false));
  } catch (e) {
    console.warn(LOG, "ウインドウの状態を確かめられなかった", e);
  }
});

// 一定間隔
async function updateAlarm() {
  const settings = await getSettings();
  try {
    await api.alarms.clear(ALARM);
    if (settings.folderSave && settings.saveTiming === "interval") {
      api.alarms.create(ALARM, { periodInMinutes: Number(settings.intervalMin) || 5 });
    }
  } catch (e) {
    console.warn(LOG, "自動保存の予定を設定できなかった", e);
  }
}
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) queued(() => flushAll(false));
});
// パネルの高さの変更などでは予定を入れ直さない（入れ直すと間隔の数え直しになるため）
api.storage.onChanged.addListener((changes, area) => {
  const change = area === "local" ? changes.settings : null;
  if (!change) return;
  const a = change.oldValue ?? {};
  const b = change.newValue ?? {};
  if (a.folderSave !== b.folderSave || a.saveTiming !== b.saveTiming || a.intervalMin !== b.intervalMin) {
    updateAlarm();
  }
});

// ---------------------------------------------------------------
// 5. 作成ウインドウ → パネル（作成ウインドウのツールバーの「パネルに戻す」）
// ---------------------------------------------------------------
// ボタンの小窓（return.html）が、確認が要るかを returnCheck で聞き、returnToPanel で実行する

// 確認の文言を返す。warn があれば小窓で確認を出す
async function returnCheck(tabId) {
  const settings = await getSettings();
  const details = await api.compose.getComposeDetails(tabId);
  const target = await composeTarget(tabId, details, null);
  if (!target) return { ok: false, error: "返信の作成ウインドウでのみ使えます" };
  const warn = [];
  const info = [];
  if (!details.isPlainText && hasFormatting(parseHtml(details.body))) {
    warn.push("書式（太字・色・リンクなど）は外れ、文字だけになります。");
  }
  const attachments = (await api.compose.listAttachments(tabId)).length;
  if (attachments && !settings.folderSave) warn.push(`添付 ${attachments} 件は破棄されます。`);
  if (attachments && settings.folderSave) info.push(`添付 ${attachments} 件は下書きに残ります（パネルでは変更できません）。`);
  if (!target.linkedSession && settings.folderSave && target.link?.draftId) {
    warn.push(
      settings.replaceOld === "move"
        ? "このメールにはパネルの下書きが既にあります。この内容に差し替え、古い下書きは設定したフォルダーへ移します。"
        : "このメールにはパネルの下書きが既にあります。この内容に差し替え、古い下書きは下書きフォルダーに残します。"
    );
  }
  return { ok: true, warn, info };
}

// 作成ウインドウの内容をパネルの下書きにし、元のメールを表示して、作成ウインドウを閉じる
async function returnToPanel(tabId) {
  const settings = await getSettings();
  const details = await api.compose.getComposeDetails(tabId);
  const target = await composeTarget(tabId, details, null);
  if (!target) return { ok: false, error: "返信の作成ウインドウでのみ使えます" };
  const { suffix, orig, linkedSession } = target;
  const tab = await api.tabs.get(tabId);

  // 本文は文字だけを移す（書式は移せない）。署名は送信時に付け直されるので外す
  let text = (details.plainTextBody ?? "").replace(/\r\n?/g, "\n");
  text = stripPlainSignature(text).replace(/\s+$/, "");

  let nextLink = null;
  if (settings.folderSave) {
    // 別の下書きで上書きする前に、パネル側の未反映の入力を下書きフォルダーへ逃がす
    if (!linkedSession && isDirty(target.content, target.link) && !target.content.empty) {
      await saveToFolder(suffix).catch((e) => console.warn(LOG, "差し替え前の保存に失敗", e));
    }
    const { link } = await readPair(suffix);
    // 作成ウインドウの内容を下書きフォルダーへ保存（添付と書式はこの下書きに残る）
    ourTabs.add(tabId);
    const before = await draftIdsSnapshot();
    const hdr = await saveDraftAndWait(tabId, orig, before);
    const ignored = [...(link?.ignored ?? [])];
    if (link?.draftId && link.draftId !== hdr.id) {
      const old = await findMessage(link.draftId, link.draftMid, "drafts");
      if (old && old.id !== hdr.id) {
        if (linkedSession) await deleteVersion(old); // 同じ1通の古い版
        else if (settings.replaceOld === "move") await moveOld(old, settings.replaceFolder);
        else ignored.push(old.headerMessageId);
      }
    }
    const attachments = (await api.compose.listAttachments(tabId)).length;
    nextLink = {
      draftId: hdr.id,
      draftMid: hdr.headerMessageId,
      // 同じ1通の編集なら過去の版を引き継いで後で消す。別の下書きへの差し替えなら古い方は設定に従うので含めない
      versions: linkedSession ? nextVersions(link, hdr.headerMessageId) : [],
      attachments,
      formatted: false,
      pending: null,
      ignored,
    };
  }

  const savedAt = Date.now();
  if (nextLink) await writeLink(suffix, { ...nextLink, syncedAt: savedAt });
  else await api.storage.local.remove(linkKeyOf(suffix));
  const bcc = joinRecipients(details.bcc);
  // パネルの下書きとして保存する。fromWindow（時刻）を見たパネルは展開して開く
  await api.storage.local.set({
    [draftKeyOf(suffix)]: {
      text,
      hasQuote: true, // 引用は本文に含まれている。送信時に付け足さない
      quote: null,
      replyAll: false,
      to: joinRecipients(details.to),
      cc: joinRecipients(details.cc),
      bcc,
      bccShown: !!bcc,
      identityId: details.identityId ?? "",
      subject: details.subject ?? "",
      headerMessageId: orig.headerMessageId ?? "",
      origId: orig.id,
      savedAt,
      fromWindow: savedAt,
    },
  });
  await setComposeLink(tabId, null);
  console.log(LOG, "作成ウインドウの内容をパネルへ移した", suffix);
  await showOriginal(orig.id);
  await api.windows.remove(tab.windowId);
  ourTabs.delete(tabId);
  // ウインドウを閉じてから、表示中のメールのアカウントの下書きフォルダーへ移す
  if (nextLink) await relocateLinked(suffix).catch((e) => console.warn(LOG, "下書きを移せなかった", e));
  return { ok: true };
}

// 宛先の配列をパネルの入力形式（カンマ区切り）にする。連絡先の参照など文字列でないものは除く
function joinRecipients(list) {
  const items = Array.isArray(list) ? list : list ? [list] : [];
  return items.filter((item) => typeof item === "string").join(", ");
}

// 元のメールをメインウインドウで表示する（別のフォルダーにあれば切り替わる）。メールのタブが無ければ新しいタブで開く
async function showOriginal(messageId) {
  try {
    const wins = await api.windows.getAll({ windowTypes: ["normal"] });
    for (const win of wins) {
      const tabs = await api.tabs.query({ windowId: win.id, type: "mail" });
      const tab = tabs.find((t) => t.active) ?? tabs[0];
      if (!tab) continue;
      await api.mailTabs.setSelectedMessages(tab.id, [messageId]);
      await api.tabs.update(tab.id, { active: true });
      await api.windows.update(win.id, win.state === "minimized" ? { state: "normal", focused: true } : { focused: true });
      return;
    }
    await api.messageDisplay.open({ messageId, location: "tab" });
  } catch (e) {
    console.warn(LOG, "元のメールを表示できなかった", e);
  }
}

// ---------------------------------------------------------------
// 6. パネル・小窓からの問い合わせ窓口
// ---------------------------------------------------------------

const failed = (e) => ({ ok: false, error: errorText(e) });

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== "object") return undefined;
  const suffix = validSuffix(msg.suffix);
  switch (msg.type) {
    case "getInfo":
      return handleGetInfo(sender);
    case "send":
    case "popout":
      return handleSend(msg, sender);
    case "flush":
      // パネルを畳んだとき（保存のタイミングが「メールを移る・畳むとき」の場合だけ）
      if (!suffix) return undefined;
      return queued(async () => {
        const settings = await getSettings();
        if (settings.saveTiming === "leave") await saveToFolder(suffix);
        return { ok: true };
      }).catch(failed);
    case "discardDraft":
      return suffix ? queued(() => discardDraft(suffix)).catch(failed) : undefined;
    case "replaceDraft":
      return suffix ? queued(() => replaceDraft(suffix)).catch(failed) : undefined;
    case "keepDraft":
      return suffix ? queued(() => keepDraft(suffix)).catch(failed) : undefined;
    case "focusCompose":
      return suffix ? focusCompose(suffix).catch(failed) : undefined;
    case "listFolders":
      return listFolders();
    case "returnCheck":
      return returnCheck(msg.tabId).catch(failed);
    case "returnToPanel":
      return queued(() => returnToPanel(msg.tabId)).catch((e) => {
        ourTabs.delete(msg.tabId);
        return failed(e);
      });
    default:
      return undefined;
  }
});

// 背景スクリプトは休止・再開するため、登録の確認と旧形式の下書きの移し替えは毎回行う
// （ファイル末尾で呼ぶのは、上で宣言した列などが使える状態になってからにするため）
registerPanel();
queued(migrateDrafts);
