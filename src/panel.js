// replyfold 返信パネル：表示中メールの文書に差し込まれる
(() => {
  "use strict";

  // 二重差し込み防止（登録分と手動差し込み分が重なりうる）
  const root = document.documentElement;
  if (!root || root.hasAttribute("data-replyfold")) return;
  root.setAttribute("data-replyfold", "1");

  const api = globalThis.messenger ?? globalThis.browser;
  const LOG = "[replyfold]";
  const BAR_HEIGHT = 40; // 折りたたみ時の高さ（panel.css と同じ値）
  const SAVE_DELAY = 400; // 下書き保存の間引き（ミリ秒）

  // パネル内部の見た目。Shadow DOM の中だけに効くので、メール本文のスタイルと干渉しない
  const STYLE = `
    :host { color-scheme: light dark; }
    * { box-sizing: border-box; }
    /* 色と寸法は _design/mockup.html に合わせる */
    .wrap {
      --bg: #ffffff; --head: #fafafa; --fg: #18181b; --sub: #71717a;
      --line: #d4d4d8; --soft: #e4e4e7; --off: #c4c4cc;
      --accent: #1373d9; --accent-fg: #ffffff; --ok: #1a7f4b; --err: #c5221f;
      height: 100%; display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-bottom: 0;
      border-radius: 10px 10px 0 0;
      box-shadow: 0 -6px 24px rgba(24, 24, 27, .16), 0 -1px 3px rgba(24, 24, 27, .10);
      font: 13px/1.5 "Segoe UI", "Yu Gothic UI", Meiryo, system-ui, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --bg: #23272e; --head: #2a2f37; --fg: #e6e8eb; --sub: #a8adb4;
        --line: #474d57; --soft: #363b44; --off: #5b616b;
        --accent: #6aa9f4; --accent-fg: #10233f; --ok: #6fcf97; --err: #f28b82;
      }
    }
    .head {
      flex: 0 0 ${BAR_HEIGHT}px; height: ${BAR_HEIGHT}px;
      display: flex; align-items: center; gap: 10px;
      padding: 0 14px; cursor: pointer; user-select: none;
    }
    .wrap.open .head { background: var(--head); border-bottom: 1px solid var(--soft); }
    .title { flex: 0 0 auto; font-weight: 600; white-space: nowrap; }
    .to { flex: 1 1 auto; min-width: 0; color: var(--sub);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { flex: 0 0 auto; font-size: 11px; padding: 1px 8px; border-radius: 10px;
             border: 1px solid var(--accent); color: var(--accent); white-space: nowrap; }
    /* 「送信しました」：緑のチェック付き */
    .note { flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
            font-weight: 600; color: var(--ok); white-space: nowrap; }
    .note::before { content: ""; width: 9px; height: 5px;
                    border-left: 2px solid var(--ok); border-bottom: 2px solid var(--ok);
                    transform: translateY(-2px) rotate(-45deg); }
    /* 「全員に返信」：スイッチ型 */
    .all { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
           font-size: 12px; white-space: nowrap; cursor: pointer; }
    .sw input { position: absolute; opacity: 0; width: 0; height: 0; }
    .sw i { flex: 0 0 auto; position: relative; width: 30px; height: 16px; border-radius: 8px;
            background: var(--off); transition: background .15s; }
    .sw i::after { content: ""; position: absolute; top: 2px; left: 2px;
                   width: 12px; height: 12px; border-radius: 50%; background: #fff;
                   transition: transform .15s; }
    .sw input:checked + i { background: var(--accent); }
    .sw input:checked + i::after { transform: translateX(14px); }
    .sw input:focus-visible + i { outline: 2px solid var(--accent); outline-offset: 2px; }
    .sw.off { opacity: .45; cursor: default; }
    /* 上端のつまみ：ドラッグで高さを変える（展開時のみ） */
    .wrap { position: relative; }
    .grip { position: absolute; top: 0; left: 0; right: 0; height: 7px; z-index: 2;
            cursor: ns-resize; touch-action: none; }
    .grip::before { content: ""; position: absolute; top: 2px; left: 50%; width: 36px; height: 3px;
                    margin-left: -18px; border-radius: 2px; background: var(--off); }
    .grip:hover::before, .grip.on::before { background: var(--accent); }
    /* 歯車と設定の小窓 */
    .main { position: relative; }
    .gear { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px;
            background: none; color: var(--sub); cursor: pointer;
            display: grid; place-items: center; }
    .gear svg { width: 18px; height: 18px; fill: none; stroke: currentColor;
                stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
    .hint + .gear { margin-left: 4px; }
    .gear:hover, .gear.on { background: color-mix(in srgb, var(--fg) 8%, transparent); color: var(--fg); }
    .pop { position: absolute; right: 12px; bottom: 58px; z-index: 1; max-width: calc(100% - 24px);
           padding: 12px 14px; display: grid; gap: 10px;
           background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
           box-shadow: 0 6px 20px rgba(24, 24, 27, .22); }
    .pop .cap { font-weight: 600; font-size: 12px; }
    .pop .sw { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
    .pop .sub { font-size: 11px; color: var(--sub); }
    .edit { flex: 0 0 auto; border: 0; background: none; color: var(--accent);
            font: inherit; font-size: 12px; cursor: pointer; padding: 4px 6px; white-space: nowrap; }
    .edit:hover { text-decoration: underline; }
    /* 開閉の矢印（折りたたみ時は上向き、展開時は下向き） */
    .fold { flex: 0 0 auto; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 4px;
            background: none; cursor: pointer; display: grid; place-items: center; }
    .fold:hover { background: color-mix(in srgb, var(--fg) 8%, transparent); }
    .fold::before { content: ""; width: 8px; height: 8px;
                    border-left: 2px solid var(--sub); border-top: 2px solid var(--sub);
                    transform: translateY(2px) rotate(45deg); }
    .wrap.open .fold::before { transform: translateY(-2px) rotate(225deg); }
    .main { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    .fields { flex: 0 0 auto; display: grid; grid-template-columns: auto 1fr;
              gap: 6px 10px; align-items: center;
              padding: 10px 16px; border-bottom: 1px solid var(--soft); }
    .fields label { font-size: 12px; color: var(--sub); white-space: nowrap; }
    .fields input {
      width: 100%; min-width: 0; height: 28px; padding: 0 8px; font: inherit;
      border: 1px solid var(--line); border-radius: 4px;
      background: var(--bg); color: var(--fg);
    }
    .fields select {
      width: 100%; min-width: 0; height: 28px; padding: 0 6px; font: inherit;
      border: 1px solid var(--line); border-radius: 4px;
      background: var(--bg); color: var(--fg);
    }
    .fields input:focus, .fields select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    textarea {
      flex: 1 1 auto; min-height: 0; width: 100%; resize: none;
      padding: 14px 16px; border: 0; outline: 0;
      background: var(--bg); color: var(--fg);
      font: inherit; font-size: 14px; line-height: 1.85;
    }
    .foot { flex: 0 0 52px; height: 52px; display: flex; align-items: center; gap: 10px;
            padding: 0 16px; border-top: 1px solid var(--soft); }
    button.send, button.discard {
      flex: 0 0 auto; height: 32px; padding: 0 18px; border-radius: 4px;
      font: inherit; white-space: nowrap; cursor: pointer;
    }
    button.send { border: 1px solid var(--accent); background: var(--accent);
                  color: var(--accent-fg); font-weight: 600; }
    button.discard { border: 1px solid var(--line); background: transparent; color: var(--fg); }
    button.send:hover:not(:disabled) { filter: brightness(1.08); }
    button.discard:hover:not(:disabled) { background: color-mix(in srgb, var(--fg) 6%, transparent); }
    button:disabled { opacity: 0.55; cursor: default; }
    .status { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--sub);
              overflow-wrap: anywhere; line-height: 1.35; }
    .status.err { color: var(--err); }
    .hint { flex: 0 0 auto; margin-left: auto; font-size: 12px; color: var(--sub);
            white-space: nowrap; }
    kbd { font: inherit; font-size: 11px; padding: 1px 5px; border-radius: 3px;
          border: 1px solid var(--line); border-bottom-width: 2px;
          background: var(--head); color: var(--fg); }
    /* 設定の小窓：項目が増えたので、パネルに収まらない分はスクロール */
    .pop { max-height: calc(100% - 66px); overflow: auto; }
    .pop .row { display: grid; gap: 4px; font-size: 12px; }
    .pop select { height: 26px; max-width: 340px; padding: 0 6px; font: inherit; font-size: 12px;
                  border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--fg); }
    /* 別の下書きへの差し替え確認 */
    .notice { flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px;
              padding: 8px 16px; font-size: 12px; border-bottom: 1px solid var(--soft);
              background: color-mix(in srgb, var(--accent) 9%, var(--bg)); }
    .notice span { flex: 1 1 260px; min-width: 0; }
    .notice button { flex: 0 0 auto; height: 26px; padding: 0 12px; border-radius: 4px; font: inherit;
                     cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
    .notice button.primary { border-color: var(--accent); background: var(--accent);
                             color: var(--accent-fg); font-weight: 600; }
    /* 添付・書式の注記 */
    .info { flex: 0 0 auto; padding: 4px 16px; font-size: 11px; color: var(--sub);
            border-bottom: 1px solid var(--soft); }
    @media (prefers-reduced-motion: reduce) { .sw i, .sw i::after { transition: none; } }
    [hidden] { display: none !important; }
  `;

  // 「名前 <アドレス>」から表示名を取り出す（無ければそのまま）
  function displayName(author) {
    const m = /^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/.exec(author || "");
    return (m && m[1].trim()) || (author || "").trim();
  }

  // 要素を作る小さな補助。文字は必ず textContent で入れる（HTML として解釈させない）
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function init() {
    let info = null;
    try {
      info = await api.runtime.sendMessage({ type: "getInfo" });
    } catch (e) {
      console.warn(LOG, "メール情報を取得できなかった", e);
    }
    // メールを特定できないとき（複数選択など）は何も出さない
    if (!info || !document.body) return;

    // 元メールの本文は、いま表示されている内容から取る（パネルを差し込む前に読む）
    const originalText = (document.body.innerText || "").replace(/\r\n?/g, "\n").trim();

    // 下書きの保存キー。元メールの Message-ID 基準（背景スクリプトが決める）
    const suffix = info.suffix || (info.headerMessageId ? `mid:${info.headerMessageId}` : `id:${info.id}`);
    const draftKey = `draft:${suffix}`;
    const linkKey = `link:${suffix}`; // 下書きフォルダーの下書きとの紐付け（背景スクリプトだけが書く）
    let link = null;
    const defaults = info.defaults || {
      sender: { to: [info.author], cc: [] },
      all: { to: [info.author], cc: [] },
      subject: info.subject,
    };
    const toName = defaults.sender.to.map(displayName).join("、");

    // ---- 組み立て ----
    const host = el("div");
    host.id = "replyfold-host";
    const shadow = host.attachShadow({ mode: "open" });
    const style = el("style");
    style.textContent = STYLE;

    const wrap = el("div", "wrap");

    const head = el("div", "head");
    const title = el("span", "title", "返信を書く");
    const to = el("span", "to", toName);
    to.title = info.subject ? `${toName} ／ ${info.subject}` : toName;
    const badge = el("span", "badge", "下書きあり");
    badge.hidden = true;
    const note = el("span", "note");
    note.hidden = true;
    const allLabel = el("label", "all sw");
    const allCheck = el("input");
    allCheck.type = "checkbox";
    allLabel.append(allCheck, el("i"), document.createTextNode("全員に返信"));
    const editBtn = el("button", "edit", "宛先・件名を編集");
    editBtn.type = "button";
    const fold = el("button", "fold");
    fold.type = "button";
    head.append(title, to, badge, note, allLabel, editBtn, fold);

    const main = el("div", "main");

    // 宛先・Cc・件名の編集欄（「宛先・件名を編集」で出す）。宛先は複数ならカンマ区切り
    const fields = el("div", "fields");
    fields.hidden = true;
    function field(labelText, id) {
      const label = el("label", "", labelText);
      const input = el("input");
      input.type = "text";
      input.id = id;
      input.spellcheck = false;
      label.htmlFor = id;
      fields.append(label, input);
      return input;
    }
    // 差出人：Thunderbird に登録済みの差出人から選ぶ。初期値は元メールの宛先だった自分のアドレス
    const fromInfo = info.from || { options: [], defaultId: null };
    const fromLabel = el("label", "", "差出人");
    const fromSelect = el("select");
    fromSelect.id = "replyfold-from";
    fromLabel.htmlFor = "replyfold-from";
    for (const opt of fromInfo.options) {
      const node = el("option", "", opt.label);
      node.value = opt.id;
      fromSelect.append(node);
    }
    if (fromInfo.defaultId) fromSelect.value = fromInfo.defaultId;
    fromLabel.hidden = fromSelect.hidden = fromInfo.options.length === 0;
    fields.append(fromLabel, fromSelect);
    function fromEmail() {
      const opt = fromInfo.options.find((o) => o.id === fromSelect.value);
      return opt ? opt.email : "";
    }

    const toInput = field("宛先", "replyfold-to");
    const ccInput = field("Cc", "replyfold-cc");
    const bccInput = field("Bcc", "replyfold-bcc"); // 歯車の「Bcc 欄を表示する」がオンのときだけ出す
    const bccLabel = bccInput.previousElementSibling;
    const subjectInput = field("件名", "replyfold-subject");
    toInput.placeholder = ccInput.placeholder = bccInput.placeholder = "複数はカンマ区切り";

    // 「返信／全員に返信」に応じた初期の宛先を入れる
    function fillRecipients() {
      const set = allCheck.checked ? defaults.all : defaults.sender;
      toInput.value = set.to.join(", ");
      ccInput.value = set.cc.join(", ");
      updateSummary();
    }
    // ヘッダーに出す宛先の要約（名前だけ）
    function updateSummary() {
      const names = toInput.value.split(",").map((s) => displayName(s)).filter(Boolean);
      const ccCount = ccInput.value.split(",").filter((s) => s.trim()).length;
      const bccCount = bccInput.hidden ? 0 : bccInput.value.split(",").filter((s) => s.trim()).length;
      const extra = [ccCount ? `Cc ${ccCount}件` : "", bccCount ? `Bcc ${bccCount}件` : ""].filter(Boolean);
      const ccNote = extra.length ? `（${extra.join("・")}）` : "";
      // 展開時はアドレスまで、折りたたみ時は名前だけ
      // 差出人は常に見せる（違うアドレスから送る事故を防ぐため）
      const fromNote = fromEmail() ? `　差出人：${fromEmail()}` : "";
      to.textContent = host.classList.contains("replyfold-open")
        ? `宛先：${toInput.value}${ccNote}${fromNote}`
        : `${names.join("、")} 宛${ccNote}`;
      to.title = `差出人：${fromEmail()}\n宛先：${toInput.value}\nCc：${ccInput.value}\n件名：${subjectInput.value}`;
    }
    subjectInput.value = defaults.subject || "";
    const textarea = el("textarea");
    textarea.placeholder = "返信を入力";
    textarea.setAttribute("aria-label", "返信の本文");
    const foot = el("div", "foot");
    const sendBtn = el("button", "send", "送信");
    sendBtn.type = "button";
    const discardBtn = el("button", "discard", "破棄");
    discardBtn.type = "button";
    const hint = el("span", "hint");
    hint.append(el("kbd", "", "Ctrl"), " + ", el("kbd", "", "Enter"), " で送信");
    const status = el("span", "status");
    status.setAttribute("role", "status");
    // 線画のアイコンを作る（24×24、線は文字色を継ぐ）
    const SVG = "http://www.w3.org/2000/svg";
    function icon(shapes) {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      for (const [tag, attrs] of shapes) {
        const node = document.createElementNS(SVG, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        svg.append(node);
      }
      return svg;
    }
    // 歯車の輪郭：8枚歯。歯の付け根（半径6.6）と歯先（半径9.4）を交互に結ぶ
    const gearPath = (() => {
      const at = (deg, r) => {
        const rad = (deg * Math.PI) / 180;
        return `${(12 + r * Math.sin(rad)).toFixed(2)} ${(12 - r * Math.cos(rad)).toFixed(2)}`;
      };
      const points = [];
      for (let i = 0; i < 8; i++) {
        const a = i * 45;
        points.push(at(a - 15, 6.6), at(a - 9, 9.4), at(a + 9, 9.4), at(a + 15, 6.6));
      }
      return `M${points.join("L")}Z`;
    })();

    const popBtn = el("button", "gear");
    popBtn.type = "button";
    popBtn.title = "別ウインドウで開く";
    popBtn.setAttribute("aria-label", "別ウインドウで開く");
    popBtn.append(
      icon([
        ["path", { d: "M13 4h7v7" }],
        ["path", { d: "M20 4l-9 9" }],
        ["path", { d: "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" }],
      ])
    );
    const gear = el("button", "gear");
    gear.type = "button";
    gear.title = "返信の設定";
    gear.setAttribute("aria-label", "返信の設定");
    gear.append(icon([["path", { d: gearPath }], ["circle", { cx: 12, cy: 12, r: 2.8 }]]));
    foot.append(sendBtn, discardBtn, status, hint, popBtn, gear);

    // ---- 元メールの引用（歯車の設定） ----
    // すべての返信に共通。storage.local の "settings" に保存する
    // panelHeight は展開時の高さ（px）。null なら初期の高さ
    // 下書きの項目の意味は background.js の DEFAULT_SETTINGS を参照（初期値もそちらと揃える）
    const settings = {
      includeOriginal: true,
      showInEditor: false,
      quoteMark: true,
      showBcc: false,
      panelHeight: null,
      folderSave: true,
      saveTiming: "leave",
      intervalMin: 5,
      replaceOld: "keep",
      replaceFolder: "",
      draftPlace: "mail",
    };
    function saveSettings() {
      api.storage.local.set({ settings: { ...settings } }).catch((e) => {
        console.warn(LOG, "設定を保存できなかった", e);
      });
    }
    const pop = el("div", "pop");
    pop.hidden = true;
    pop.append(el("div", "cap", "元メールの扱い"));
    // quote＝入力欄の引用に関わる設定か（関わらない設定で下書きを保存し直さないため）
    function option(key, labelText, onChange, quote = true) {
      const label = el("label", "sw");
      const input = el("input");
      input.type = "checkbox";
      label.append(input, el("i"), document.createTextNode(labelText));
      pop.append(label);
      input.addEventListener("change", () => {
        settings[key] = input.checked;
        if (onChange) onChange();
        renderSettings();
        if (quote) {
          syncEditorQuote();
          scheduleSave();
        }
        saveSettings();
      });
      return { label, input };
    }
    // プルダウンの設定。cast は保存する値の型（間隔は数値）
    function choice(labelText, key, items, cast = String) {
      const row = el("label", "row");
      const select = el("select");
      for (const [value, text] of items) {
        const node = el("option", "", text);
        node.value = value;
        select.append(node);
      }
      row.append(document.createTextNode(labelText), select);
      pop.append(row);
      select.addEventListener("change", () => {
        settings[key] = cast(select.value);
        renderSettings();
        saveSettings();
      });
      return { row, select };
    }
    const optInclude = option("includeOriginal", "元メールを返信の下に入れる");
    const optShow = option("showInEditor", "元メールを入力欄に表示して編集する");
    const optMark = option("quoteMark", "元メールの各行に「>」を付ける");
    pop.append(el("div", "cap", "宛先欄"));
    const optBcc = option("showBcc", "Bcc 欄を表示する", () => {
      // オンにしたら、欄が見えるよう宛先の編集欄を開く
      if (settings.showBcc) fields.hidden = false;
    });
    pop.append(el("div", "cap", "下書き"));
    const optFolder = option("folderSave", "Thunderbird の下書きフォルダーにも保存する", null, false);
    const selPlace = choice("保存先", "draftPlace", [
      ["mail", "表示中のメールのアカウントの下書きフォルダー"],
      ["sender", "差出人のアカウントの下書きフォルダー（Thunderbird 標準）"],
    ]);
    const selTiming = choice("下書きフォルダーへ保存するタイミング", "saveTiming", [
      ["leave", "別のメールへ移る・パネルを畳むとき"],
      ["minimize", "Thunderbird を最小化したとき"],
      ["interval", "一定の間隔で"],
    ]);
    const selInterval = choice(
      "間隔",
      "intervalMin",
      [2, 5, 10, 30, 60].map((n) => [String(n), `${n} 分ごと`]),
      Number
    );
    const selReplace = choice("別の下書きに差し替えたときの古い下書き", "replaceOld", [
      ["keep", "下書きフォルダーに残す"],
      ["move", "指定したフォルダーへ移す"],
    ]);
    const selFolder = choice("移動先のフォルダー", "replaceFolder", [["", "その下書きのアカウントのごみ箱"]]);
    // フォルダーの一覧は、移動先を選ぶときに初めて読む
    let foldersLoaded = false;
    async function loadFolders() {
      if (foldersLoaded) return;
      foldersLoaded = true;
      let list = [];
      try {
        list = (await api.runtime.sendMessage({ type: "listFolders" })) || [];
      } catch (e) {
        console.warn(LOG, "フォルダーの一覧を取得できなかった", e);
      }
      for (const folder of list) {
        const existing = [...selFolder.select.options].find((o) => o.value === folder.id);
        if (existing) {
          existing.textContent = folder.label; // 仮の項目を正しい名前に
          continue;
        }
        const node = el("option", "", folder.label);
        node.value = folder.id;
        selFolder.select.append(node);
      }
      selFolder.select.value = settings.replaceFolder;
    }
    pop.append(el("div", "sub", "すべての返信に共通の設定です"));

    function renderSettings() {
      optFolder.input.checked = settings.folderSave;
      selTiming.select.value = settings.saveTiming;
      selInterval.select.value = String(settings.intervalMin);
      selReplace.select.value = settings.replaceOld;
      // 保存済みの移動先が一覧に未読込なら、仮の項目で値を保つ
      if (settings.replaceFolder && ![...selFolder.select.options].some((o) => o.value === settings.replaceFolder)) {
        const node = el("option", "", "（設定済みのフォルダー）");
        node.value = settings.replaceFolder;
        selFolder.select.append(node);
      }
      selFolder.select.value = settings.replaceFolder;
      selPlace.select.value = settings.draftPlace;
      selPlace.row.hidden = selTiming.row.hidden = selReplace.row.hidden = !settings.folderSave;
      selInterval.row.hidden = !settings.folderSave || settings.saveTiming !== "interval";
      selFolder.row.hidden = !settings.folderSave || settings.replaceOld !== "move";
      if (!selFolder.row.hidden) loadFolders();
      optBcc.input.checked = settings.showBcc;
      bccLabel.hidden = bccInput.hidden = !settings.showBcc;
      render();
      optInclude.input.checked = settings.includeOriginal;
      optShow.input.checked = settings.showInEditor;
      optMark.input.checked = settings.quoteMark;
      // 元メールを入れないなら、残り2つは意味を持たない
      for (const opt of [optShow, optMark]) {
        opt.input.disabled = !settings.includeOriginal;
        opt.label.classList.toggle("off", !settings.includeOriginal);
      }
    }

    // 引用の見出し行（Thunderbird 標準の形に合わせる）
    const quoteHeader = (() => {
      const name = displayName(info.author);
      if (!info.date) return `${name} wrote:`;
      const d = new Date(info.date);
      const p = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      return `On ${stamp}, ${name} wrote:`;
    })();

    // 入力欄へ入れる引用（本文との間に空行を置く）
    function editorQuote() {
      if (!settings.includeOriginal || !settings.showInEditor || !originalText) return "";
      const body = settings.quoteMark
        ? originalText.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")
        : originalText;
      return `\n\n${quoteHeader}\n${body}`;
    }

    let autoTail = ""; // 入力欄の末尾に自動で入れた引用。書き換えられていなければ末尾と一致する
    let quoteLocked = false; // 入力欄の引用をユーザーが書き換えた。以後は自動で差し替えない

    // 入力欄のうち、ユーザーが書いた部分（自動で入れた引用を除く）
    function userText() {
      const value = textarea.value;
      return autoTail && value.endsWith(autoTail) ? value.slice(0, -autoTail.length) : value;
    }

    // 設定に合わせて、入力欄の引用を入れる・外す・差し替える
    function syncEditorQuote() {
      if (quoteLocked) return;
      const value = textarea.value;
      if (autoTail && !value.endsWith(autoTail)) {
        // 引用を書き換えた跡がある。ユーザーの編集を壊さないよう触らない
        quoteLocked = true;
        autoTail = "";
        return;
      }
      const base = userText();
      autoTail = editorQuote();
      textarea.value = base + autoTail;
      textarea.setSelectionRange(base.length, base.length);
      textarea.scrollTop = 0;
    }

    function closePop() {
      pop.hidden = true;
      gear.classList.remove("on");
    }

    // 標準の作成ウインドウで書かれた別の下書きが見つかったときの確認
    const notice = el("div", "notice");
    notice.hidden = true;
    const replaceBtn = el("button", "primary", "差し替える");
    replaceBtn.type = "button";
    const keepBtn = el("button", "", "今のままにする");
    keepBtn.type = "button";
    notice.append(
      el("span", "", "このメールへの下書きがほかに1通あります。そちらを最新として差し替えますか？"),
      replaceBtn,
      keepBtn
    );
    // 作成ウインドウで編集中の表示（その間パネルは読み取り専用）
    const lockBar = el("div", "notice");
    lockBar.hidden = true;
    const focusBtn = el("button", "primary", "ウインドウを表示");
    focusBtn.type = "button";
    lockBar.append(
      el("span", "", "別ウインドウで編集中です。パネルに戻すには、作成ウインドウの「パネルに戻す」を押してください。"),
      focusBtn
    );
    let locked = false;
    // 添付・書式の注記（下書きフォルダーの下書きに添付や書式があるとき）
    const infoLine = el("div", "info");
    infoLine.hidden = true;

    main.append(lockBar, notice, infoLine, fields, textarea, foot, pop);
    fillRecipients();

    const grip = el("div", "grip");
    grip.title = "ドラッグで高さを変更（ダブルクリックで元に戻す）";
    wrap.append(grip, head, main);
    shadow.append(style, wrap);

    // ---- 状態 ----
    let open = false;
    let busy = false;
    let saveTimer = null;
    let noteTimer = null;

    function setPadding() {
      // 本文の最後までスクロールで読めるよう、パネルの高さ分の余白を取る
      const px = open ? Math.round(host.getBoundingClientRect().height) || BAR_HEIGHT : BAR_HEIGHT;
      root.style.setProperty("--replyfold-pad", `${px + 8}px`);
    }

    function render() {
      host.classList.toggle("replyfold-open", open);
      wrap.classList.toggle("open", open);
      title.textContent = open ? "返信" : "返信を書く";
      // 「送信しました」を出している間は、モックどおり題名と宛先を隠す
      const noting = !open && !note.hidden;
      title.hidden = noting;
      to.style.visibility = noting ? "hidden" : "";
      grip.hidden = !open;
      allLabel.hidden = !open;
      editBtn.hidden = !open;
      editBtn.textContent = fields.hidden ? "宛先・件名を編集" : "編集欄を閉じる";
      fold.title = open ? "折りたたむ" : "開く";
      fold.setAttribute("aria-label", fold.title);
      updateSummary();
      main.inert = !open; // 折りたたみ中は入力欄へフォーカスを入れない
      if (!open) closePop();
      const pending = !!(settings.folderSave && link && link.pending) && !locked;
      badge.textContent = locked ? "別ウインドウで編集中" : pending ? "下書きの確認" : "下書きあり";
      badge.hidden = open || !(locked || pending || userText().trim());
      notice.hidden = !pending;
      lockBar.hidden = !locked;
      const notes = [];
      if (settings.folderSave && link && link.attachments) {
        notes.push(`添付 ${link.attachments} 件（追加・削除は別ウインドウで）`);
      }
      if (settings.folderSave && link && link.formatted) {
        notes.push("書式付きの下書きです。パネルで編集すると書式は外れます");
      }
      infoLine.textContent = notes.join("　／　");
      infoLine.hidden = !notes.length;
    }

    // 自分の文の終わり。作成ウインドウや下書きから戻した文は引用ごと入っているので、
    // 引用の見出し行（「… wrote:」）か最初の「>」の行の手前を探す
    function ownTextEnd() {
      if (!quoteLocked) return userText().replace(/\s+$/, "").length;
      const value = textarea.value;
      const m = /\n*^(?:.*(?:wrote|書きました)[:：][ \t]*|>.*)$/m.exec(value);
      return m ? m.index : value.replace(/\s+$/, "").length;
    }

    function setOpen(next) {
      if (open === next) return;
      open = next;
      render();
      if (open) {
        // カーソルは自分の文の末尾（引用の手前）に置き、入力欄は先頭から見せる
        const at = ownTextEnd();
        textarea.focus();
        textarea.setSelectionRange(at, at);
        textarea.scrollTop = 0;
        // 開くアニメーションの後にも先頭へ戻す（高さが変わる途中でカーソル位置へ流れるため）
        setTimeout(() => {
          textarea.scrollTop = 0;
        }, 250);
      } else flushDraft().then(requestFolderSave);
      // アニメーション無効の環境では transitionend が来ないので、時間でも余白を更新する
      setTimeout(setPadding, 250);
    }

    function setStatus(text, isError) {
      status.textContent = text || "";
      status.classList.toggle("err", !!isError);
    }

    // 折りたたみ中のバーに出す短い通知（「送信しました」）
    function showNote(text) {
      clearTimeout(noteTimer);
      note.textContent = text;
      note.hidden = false;
      render();
      noteTimer = setTimeout(() => {
        note.hidden = true;
        render();
      }, 4000);
    }

    // ---- 下書き ----
    // 送信時に付ける引用（入力欄に引用が入っていれば null）
    function quoteFor(quoteInEditor) {
      return settings.includeOriginal && !quoteInEditor && originalText
        ? { header: quoteHeader, body: originalText, mark: settings.quoteMark }
        : null;
    }

    async function saveDraft() {
      saveTimer = null;
      try {
        // 自動で入れた引用だけなら下書きではない
        if (!userText().trim()) {
          if (settings.folderSave && link && link.draftId) {
            // 下書きフォルダーに紐づく下書きがあるときは「空にした」印を残し、次の保存でそちらも片付ける
            await api.storage.local.set({
              [draftKey]: { text: "", empty: true, headerMessageId: info.headerMessageId, origId: info.id, savedAt: Date.now() },
            });
          } else {
            await api.storage.local.remove(draftKey);
          }
          return;
        }
        const quoteInEditor = !!autoTail || quoteLocked;
        await api.storage.local.set({
          [draftKey]: {
            text: textarea.value,
            // 入力欄に引用が含まれているか（復元時に二重に入れないため）
            hasQuote: quoteInEditor,
            // 下書きフォルダーへ保存するとき、背景スクリプトが付ける引用
            quote: quoteFor(quoteInEditor),
            replyAll: allCheck.checked,
            to: toInput.value,
            cc: ccInput.value,
            bcc: bccInput.value,
            bccShown: settings.showBcc,
            identityId: fromSelect.value,
            subject: subjectInput.value,
            // 照合用の Message-ID と、元メールを引くためのメールID
            headerMessageId: info.headerMessageId,
            origId: info.id,
            savedAt: Date.now(),
          },
        });
      } catch (e) {
        console.warn(LOG, "下書きを保存できなかった", e);
      }
    }

    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveDraft, SAVE_DELAY);
    }

    async function flushDraft() {
      if (saveTimer === null) return;
      clearTimeout(saveTimer);
      await saveDraft();
    }

    // 畳んだとき：保存のタイミングが「メールを移る・畳むとき」なら下書きフォルダーへ反映を頼む
    function requestFolderSave() {
      if (!settings.folderSave || settings.saveTiming !== "leave") return;
      api.runtime.sendMessage({ type: "flush", suffix }).catch((e) => {
        console.warn(LOG, "下書きフォルダーへの保存を頼めなかった", e);
      });
    }

    async function removeDraft() {
      clearTimeout(saveTimer);
      saveTimer = null;
      try {
        await api.storage.local.remove(draftKey);
      } catch (e) {
        console.warn(LOG, "下書きを消せなかった", e);
      }
    }

    // force＝作成ウインドウや下書きフォルダーから来た内容で、入力中の文を置き換える
    async function restoreDraft(force) {
      try {
        const stored = await api.storage.local.get(draftKey);
        const draft = stored ? stored[draftKey] : null;
        if (!draft || typeof draft.text !== "string" || draft.empty) return null;
        if (force) {
          textarea.value = "";
          autoTail = "";
          quoteLocked = false;
        }
        // 別のメールの下書きが同じIDに残っていたら使わない（誤送信防止）
        if ((draft.headerMessageId || "") !== (info.headerMessageId || "")) {
          await api.storage.local.remove(draftKey);
          return null;
        }
        // 読み込み中に入力が始まっていたら上書きしない
        if (userText()) return null;
        textarea.value = draft.text;
        autoTail = "";
        if (draft.hasQuote) {
          // 保存時の引用がそのまま残っていれば自動分として扱い、書き換えられていれば触らない
          const tail = editorQuote();
          if (tail && draft.text.endsWith(tail)) autoTail = tail;
          else quoteLocked = true;
        }
        allCheck.checked = draft.replyAll === true;
        fillRecipients();
        // 手で直した宛先・件名があれば、それを優先して戻す
        if (typeof draft.to === "string" && draft.to.trim()) toInput.value = draft.to;
        if (typeof draft.cc === "string") ccInput.value = draft.cc;
        bccInput.value = typeof draft.bcc === "string" ? draft.bcc : "";
        // 保存時の差出人が今も登録されていれば戻す
        if (fromInfo.options.some((o) => o.id === draft.identityId)) fromSelect.value = draft.identityId;
        if (typeof draft.subject === "string" && draft.subject.trim()) subjectInput.value = draft.subject;
        updateSummary();
        return draft;
      } catch (e) {
        console.warn(LOG, "下書きを読めなかった", e);
        return null;
      }
    }

    // 作成ウインドウの「パネルに戻す」直後か（その印は時刻。古い印では開かない）
    function justReturned(draft) {
      return !!draft && typeof draft.fromWindow === "number" && Date.now() - draft.fromWindow < 15000;
    }

    // 作成ウインドウから戻った内容を、展開したパネルで見せる
    function showReturned() {
      syncEditorQuote();
      if (!fields.hidden || toInput.value !== (allCheck.checked ? defaults.all : defaults.sender).to.join(", ")) {
        fields.hidden = false; // 宛先が初期値と違うなら、見えるように編集欄を開く
      }
      setOpen(true);
      render();
    }

    // ---- 送信 ----
    function setBusy(next) {
      busy = next;
      syncControls();
      sendBtn.textContent = next ? "送信中…" : "送信";
    }

    // 処理中、または作成ウインドウで編集中（locked）の間は、入力と操作を止める
    function syncControls() {
      const stop = busy || locked;
      sendBtn.disabled = discardBtn.disabled = popBtn.disabled = gear.disabled = stop;
      replaceBtn.disabled = keepBtn.disabled = stop;
      allCheck.disabled = stop;
      textarea.readOnly = stop;
      toInput.readOnly = ccInput.readOnly = bccInput.readOnly = subjectInput.readOnly = stop;
      fromSelect.disabled = stop;
      if (stop) closePop();
    }

    async function send() {
      if (busy || locked) return;
      const text = textarea.value;
      if (!userText().trim()) {
        setStatus("本文を入力してください", true);
        return;
      }
      // 入力欄に引用が入っていれば、それがそのまま送られる。入っていなければ送信時に付ける
      const quote = quoteFor(!!autoTail || quoteLocked);
      if (!toInput.value.trim()) {
        fields.hidden = false;
        render();
        setStatus("宛先を入力してください", true);
        toInput.focus();
        return;
      }
      setBusy(true);
      setStatus("");
      let result = null;
      try {
        result = await api.runtime.sendMessage({
          type: "send",
          messageId: info.id,
          suffix,
          text,
          quote,
          replyAll: allCheck.checked,
          to: toInput.value,
          cc: ccInput.value,
          bcc: bccValue(),
          identityId: fromSelect.value,
          subject: subjectInput.value,
        });
      } catch (e) {
        result = { ok: false, error: (e && e.message) || String(e) };
      }
      setBusy(false);

      if (result && result.ok) {
        clearText();
        resetFields();
        await removeDraft();
        setStatus("");
        showNote("送信しました");
        setOpen(false);
        render();
      } else {
        // 入力は残す。理由を赤字で出し、そのまま再送信できる
        const reason = (result && result.error) || "不明なエラー";
        setStatus(`送信できませんでした：${reason}`, true);
      }
    }

    // Bcc 欄を隠している間は値を渡さない（見えない宛先へ送らないため）。
    // null のときは Thunderbird 側の Bcc に触らない
    function bccValue() {
      return settings.showBcc ? bccInput.value : null;
    }

    // 宛先・件名を初期値へ戻し、編集欄を閉じる
    function resetFields() {
      allCheck.checked = false;
      bccInput.value = "";
      if (fromInfo.defaultId) fromSelect.value = fromInfo.defaultId;
      subjectInput.value = defaults.subject || "";
      fields.hidden = true;
      fillRecipients();
    }

    // 書きかけの内容を標準の作成ウインドウへ引き継ぐ（添付や書式を使いたいとき）
    async function popout() {
      if (busy || locked) return;
      await flushDraft(); // 作成ウインドウを閉じて戻ったとき、この時点の内容から続けられるように
      setBusy(true);
      sendBtn.textContent = "送信"; // 送信ではないので「送信中…」にしない
      setStatus("別ウインドウで開いています…");
      let result = null;
      try {
        result = await api.runtime.sendMessage({
          type: "popout",
          messageId: info.id,
          suffix,
          text: textarea.value,
          quote: quoteFor(!!autoTail || quoteLocked),
          replyAll: allCheck.checked,
          to: toInput.value,
          cc: ccInput.value,
          bcc: bccValue(),
          identityId: fromSelect.value,
          subject: subjectInput.value,
        });
      } catch (e) {
        result = { ok: false, error: (e && e.message) || String(e) };
      }
      setBusy(false);
      if (result && result.ok) {
        // 続きは作成ウインドウ側で書く。パネルは内容を残したまま「別ウインドウで編集中」としてロックされる
        setStatus("");
        setOpen(false);
        render();
      } else {
        setStatus(`別ウインドウで開けませんでした：${(result && result.error) || "不明なエラー"}`, true);
      }
    }

    // 入力欄を空にし、設定に応じて引用だけ入れ直す
    function clearText() {
      textarea.value = "";
      autoTail = "";
      quoteLocked = false;
      syncEditorQuote();
    }

    // 破棄：パネルを空にし、下書きフォルダーの下書きもごみ箱へ移す
    async function discard() {
      if (busy || locked) return;
      clearText();
      resetFields();
      await removeDraft();
      try {
        await api.runtime.sendMessage({ type: "discardDraft", suffix });
      } catch (e) {
        console.warn(LOG, "下書きフォルダーの下書きを片付けられなかった", e);
      }
      setStatus("");
      setOpen(false);
      render();
    }

    // 別の下書きへの差し替え確認の操作
    async function answerPending(type) {
      if (busy || locked) return;
      await flushDraft();
      setBusy(true);
      sendBtn.textContent = "送信"; // 送信ではないので「送信中…」にしない
      replaceBtn.disabled = keepBtn.disabled = true;
      if (type === "replaceDraft") setStatus("差し替えています…");
      let result = null;
      try {
        result = await api.runtime.sendMessage({ type, suffix });
      } catch (e) {
        result = { ok: false, error: (e && e.message) || String(e) };
      }
      setBusy(false);
      replaceBtn.disabled = keepBtn.disabled = false;
      if (result && result.ok) setStatus("");
      else setStatus(`差し替えられませんでした：${(result && result.error) || "不明なエラー"}`, true);
    }

    // ---- 操作 ----
    head.addEventListener("click", (ev) => {
      // 「全員に返信」の操作では開閉しない
      if (allLabel.contains(ev.target) || editBtn.contains(ev.target)) return;
      setOpen(!open);
    });
    // 切り替えたら、その種類の初期宛先に入れ直す
    allCheck.addEventListener("change", () => {
      fillRecipients();
      scheduleSave();
    });
    editBtn.addEventListener("click", () => {
      fields.hidden = !fields.hidden;
      render();
      if (!fields.hidden) toInput.focus();
    });
    for (const input of [toInput, ccInput, bccInput, subjectInput]) {
      input.addEventListener("input", () => {
        if (status.classList.contains("err")) setStatus("");
        updateSummary();
        scheduleSave();
      });
    }
    fromSelect.addEventListener("change", () => {
      updateSummary();
      scheduleSave();
    });
    textarea.addEventListener("input", () => {
      if (status.classList.contains("err")) setStatus("");
      scheduleSave();
    });
    textarea.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        send();
      }
    });
    sendBtn.addEventListener("click", send);
    discardBtn.addEventListener("click", discard);
    popBtn.addEventListener("click", popout);
    replaceBtn.addEventListener("click", () => answerPending("replaceDraft"));
    keepBtn.addEventListener("click", () => answerPending("keepDraft"));
    focusBtn.addEventListener("click", () => {
      api.runtime.sendMessage({ type: "focusCompose", suffix }).catch((e) => {
        console.warn(LOG, "作成ウインドウを表示できなかった", e);
      });
    });

    // 作成ウインドウとの対応表に、このメールの下書きを編集中のウインドウがあるか
    function applyLock(links) {
      const next = Object.values(links || {}).includes(suffix);
      if (next === locked) return;
      locked = next;
      syncControls();
      render();
    }

    // 背景スクリプトからの変化を反映する
    api.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      if (changes.composeLinks) applyLock(changes.composeLinks.newValue);
      if (changes[linkKey]) {
        link = changes[linkKey].newValue || null;
        render();
      }
      const change = changes[draftKey];
      if (!change) return;
      const next = change.newValue;
      if (!next) {
        // 外で下書きが消えた（下書きフォルダーから削除・作成ウインドウから送信）。
        // パネルが保存したときのままなら空にする（入力が進んでいれば触らない）
        const prev = change.oldValue;
        if (!busy && prev && !prev.empty && saveTimer === null && textarea.value === prev.text) {
          clearText();
          resetFields();
          render();
        }
        return;
      }
      // 作成ウインドウから戻された内容・下書きフォルダーから読み直した内容で置き換える
      const returned = justReturned(next);
      if (!returned && !next.external) return;
      await restoreDraft(true);
      if (returned) showReturned();
      else {
        syncEditorQuote();
        render();
      }
    });

    // 上端のつまみ：ドラッグで高さを変える。下限 220px、上限は表示エリアの高さ − 8px
    const MIN_HEIGHT = 220;
    function applyHeight() {
      if (settings.panelHeight) host.style.setProperty("--replyfold-h", `${settings.panelHeight}px`);
      else host.style.removeProperty("--replyfold-h");
    }
    let drag = null;
    grip.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      drag = { y: ev.clientY, h: host.getBoundingClientRect().height };
      grip.setPointerCapture(ev.pointerId);
      grip.classList.add("on");
      host.classList.add("replyfold-drag");
    });
    grip.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const max = Math.max(MIN_HEIGHT, window.innerHeight - 8);
      const next = Math.min(max, Math.max(MIN_HEIGHT, drag.h + (drag.y - ev.clientY)));
      settings.panelHeight = Math.round(next);
      applyHeight();
    });
    function endDrag() {
      if (!drag) return;
      drag = null;
      grip.classList.remove("on");
      host.classList.remove("replyfold-drag");
      setPadding();
      saveSettings();
    }
    grip.addEventListener("pointerup", endDrag);
    grip.addEventListener("pointercancel", endDrag);
    grip.addEventListener("dblclick", () => {
      settings.panelHeight = null;
      applyHeight();
      saveSettings();
      setTimeout(setPadding, 250);
    });
    // つまみの操作でパネルを開閉させない
    grip.addEventListener("click", (ev) => ev.stopPropagation());

    // 歯車：設定の小窓を開閉。小窓の外をクリックするか Esc で閉じる
    gear.addEventListener("click", () => {
      if (busy) return;
      pop.hidden = !pop.hidden;
      gear.classList.toggle("on", !pop.hidden);
    });
    wrap.addEventListener("click", (ev) => {
      if (pop.hidden || pop.contains(ev.target) || gear.contains(ev.target)) return;
      closePop();
    });
    wrap.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && !pop.hidden) {
        closePop();
        gear.focus();
      }
    });

    // 入力中のキー操作をメール側へ伝えない
    for (const type of ["keydown", "keypress", "keyup"]) {
      host.addEventListener(type, (ev) => ev.stopPropagation());
    }
    // 開閉アニメーションの終わりと表示サイズの変化に合わせて、本文の下余白を更新
    host.addEventListener("transitionend", setPadding);
    window.addEventListener("resize", setPadding);
    // 別のメールへ移る直前に、間引き中の下書きを書き切る
    window.addEventListener("pagehide", flushDraft);

    // ---- 表示 ----
    root.classList.add("replyfold-on");
    document.body.appendChild(host);
    render();
    setPadding();
    try {
      const stored = await api.storage.local.get("settings");
      Object.assign(settings, stored && stored.settings);
    } catch (e) {
      console.warn(LOG, "設定を読めなかった（初期値で続行）", e);
    }
    try {
      const stored = await api.storage.local.get([linkKey, "composeLinks"]);
      link = (stored && stored[linkKey]) || null;
      applyLock(stored && stored.composeLinks);
    } catch (e) {
      console.warn(LOG, "下書きの紐付けを読めなかった", e);
    }
    renderSettings();
    applyHeight();
    const draft = await restoreDraft();
    if (justReturned(draft)) showReturned();
    else {
      syncEditorQuote();
      render();
    }
  }

  init().catch((e) => console.error(LOG, "パネルの初期化に失敗", e));
})();
