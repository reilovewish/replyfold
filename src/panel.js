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

    const draftKey = `draft:${info.id}`;
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
    const settings = {
      includeOriginal: true,
      showInEditor: false,
      quoteMark: true,
      showBcc: false,
      panelHeight: null,
    };
    function saveSettings() {
      api.storage.local.set({ settings: { ...settings } }).catch((e) => {
        console.warn(LOG, "設定を保存できなかった", e);
      });
    }
    const pop = el("div", "pop");
    pop.hidden = true;
    pop.append(el("div", "cap", "元メールの扱い"));
    function option(key, labelText, onChange) {
      const label = el("label", "sw");
      const input = el("input");
      input.type = "checkbox";
      label.append(input, el("i"), document.createTextNode(labelText));
      pop.append(label);
      input.addEventListener("change", () => {
        settings[key] = input.checked;
        if (onChange) onChange();
        renderSettings();
        syncEditorQuote();
        scheduleSave();
        saveSettings();
      });
      return { label, input };
    }
    const optInclude = option("includeOriginal", "元メールを返信の下に入れる");
    const optShow = option("showInEditor", "元メールを入力欄に表示して編集する");
    const optMark = option("quoteMark", "元メールの各行に「>」を付ける");
    pop.append(el("div", "cap", "宛先欄"));
    const optBcc = option("showBcc", "Bcc 欄を表示する", () => {
      // オンにしたら、欄が見えるよう宛先の編集欄を開く
      if (settings.showBcc) fields.hidden = false;
    });
    pop.append(el("div", "sub", "すべての返信に共通の設定です"));

    function renderSettings() {
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

    main.append(fields, textarea, foot, pop);
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
      badge.hidden = open || !userText().trim();
    }

    function setOpen(next) {
      if (open === next) return;
      open = next;
      render();
      if (open) {
        // カーソルは自分の文の末尾（引用の手前）に置く
        const at = userText().length;
        textarea.focus();
        textarea.setSelectionRange(at, at);
      } else flushDraft();
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
    async function saveDraft() {
      saveTimer = null;
      try {
        // 自動で入れた引用だけなら下書きではない
        if (!userText().trim()) {
          await api.storage.local.remove(draftKey);
          return;
        }
        await api.storage.local.set({
          [draftKey]: {
            text: textarea.value,
            // 入力欄に引用が含まれているか（復元時に二重に入れないため）
            hasQuote: !!autoTail || quoteLocked,
            replyAll: allCheck.checked,
            to: toInput.value,
            cc: ccInput.value,
            bcc: bccInput.value,
            identityId: fromSelect.value,
            subject: subjectInput.value,
            // メールIDは再起動で別のメールを指しうるので、照合用に Message-ID を一緒に持つ
            headerMessageId: info.headerMessageId,
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

    function flushDraft() {
      if (saveTimer === null) return;
      clearTimeout(saveTimer);
      saveDraft();
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

    // force＝作成ウインドウから戻された内容で、入力中の文を置き換える
    async function restoreDraft(force) {
      try {
        const stored = await api.storage.local.get(draftKey);
        const draft = stored ? stored[draftKey] : null;
        if (!draft || typeof draft.text !== "string") return;
        if (force) {
          textarea.value = "";
          quoteLocked = false;
        }
        // 別のメールの下書きが同じIDに残っていたら使わない（誤送信防止）
        if ((draft.headerMessageId || "") !== (info.headerMessageId || "")) {
          await api.storage.local.remove(draftKey);
          return;
        }
        // 読み込み中に入力が始まっていたら上書きしない
        if (userText()) return;
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
      } catch (e) {
        console.warn(LOG, "下書きを読めなかった", e);
      }
    }

    // ---- 送信 ----
    function setBusy(next) {
      busy = next;
      sendBtn.disabled = next;
      discardBtn.disabled = next;
      popBtn.disabled = next;
      allCheck.disabled = next;
      textarea.readOnly = next;
      toInput.readOnly = ccInput.readOnly = bccInput.readOnly = subjectInput.readOnly = next;
      fromSelect.disabled = next;
      sendBtn.textContent = next ? "送信中…" : "送信";
    }

    async function send() {
      if (busy) return;
      const text = textarea.value;
      if (!userText().trim()) {
        setStatus("本文を入力してください", true);
        return;
      }
      // 入力欄に引用が入っていれば、それがそのまま送られる。入っていなければ送信時に付ける
      const quoteInEditor = !!autoTail || quoteLocked;
      const quote =
        settings.includeOriginal && !quoteInEditor && originalText
          ? { header: quoteHeader, body: originalText, mark: settings.quoteMark }
          : null;
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
      if (busy) return;
      setBusy(true);
      sendBtn.textContent = "送信"; // 送信ではないので「送信中…」にしない
      setStatus("別ウインドウで開いています…");
      const quoteInEditor = !!autoTail || quoteLocked;
      let result = null;
      try {
        result = await api.runtime.sendMessage({
          type: "popout",
          messageId: info.id,
          text: textarea.value,
          quote:
            settings.includeOriginal && !quoteInEditor && originalText
              ? { header: quoteHeader, body: originalText, mark: settings.quoteMark }
              : null,
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
        // 続きは作成ウインドウ側で書く。二重に残さないようパネル側は空にする
        clearText();
        resetFields();
        await removeDraft();
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

    async function discard() {
      if (busy) return;
      clearText();
      resetFields();
      await removeDraft();
      setStatus("");
      setOpen(false);
      render();
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

    // 作成ウインドウの「パネルに戻す」で下書きが書き込まれたら、その内容で開く
    api.storage.onChanged.addListener(async (changes, area) => {
      const change = area === "local" ? changes[draftKey] : null;
      if (!change || !change.newValue || !change.newValue.fromWindow) return;
      await restoreDraft(true);
      syncEditorQuote();
      if (!fields.hidden || toInput.value !== (allCheck.checked ? defaults.all : defaults.sender).to.join(", ")) {
        fields.hidden = false; // 宛先が初期値と違うなら、見えるように編集欄を開く
      }
      setOpen(true);
      render();
      scheduleSave(); // fromWindow の印を外して保存し直す
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
    renderSettings();
    applyHeight();
    await restoreDraft();
    syncEditorQuote();
    render();
  }

  init().catch((e) => console.error(LOG, "パネルの初期化に失敗", e));
})();
