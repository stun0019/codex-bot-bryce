(() => {
  const board = document.getElementById("observerBoard");
  const cards = document.getElementById("observerCards");
  const status = document.getElementById("observerStatus");
  if (!board || !cards || !status) return;

  const line = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = content;
    return node;
  };
  const formatTime = (ms) => new Date(ms).toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei", hour12: false,
  });
  const formatPrice = (price) => Number(price).toLocaleString("en-US", {
    maximumFractionDigits: 8,
  });

  async function refresh() {
    try {
      const [statusResponse, candidatesResponse] = await Promise.all([
        fetch("/api/observer/status", { cache: "no-store" }),
        fetch("/api/observer/candidates", { cache: "no-store" }),
      ]);
      if (!statusResponse.ok || !candidatesResponse.ok) throw new Error("Backend unavailable");
      const info = await statusResponse.json();
      const observations = await candidatesResponse.json();
      board.hidden = false;
      status.textContent = info.error ? "部分行情讀取失敗" :
        info.last_scan_utc ? "最近掃描 " + formatTime(info.last_scan_utc) : "等待首次掃描";
      cards.replaceChildren();
      if (!observations.length) {
        cards.append(line("p", "observer-empty", "目前沒有符合條件的觀察標的"));
        return;
      }
      for (const item of observations) {
        const card = line("article", "observer-card", "");
        const top = line("div", "observer-card-top", "");
        top.append(line("strong", "", item.symbol + " · " + item.pair));
        const side = line("span", "observer-card-side", item.side === "LONG" ? "多頭觀察" : "空頭觀察");
        side.dataset.side = item.side;
        top.append(side);
        card.append(top);
        card.append(line("p", "", "高週期 OB 已回踩 → 低週期 CHOCH → 低週期 OB 已形成"));
        card.append(line("p", "", "低週期 OB：" + formatPrice(item.ltf_ob.low) + " ～ " + formatPrice(item.ltf_ob.high)));
        card.append(line("p", "", "形成時間：" + formatTime(item.formed_ms) + " · 等待人工觀察"));
        cards.append(card);
      }
    } catch {
      board.hidden = true;
    }
  }
  refresh();
  window.setInterval(refresh, 60_000);
})();
