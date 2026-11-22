/* Static GitHub Pages client. Data generation/inference happens outside the browser. */
"use strict";

(() => {
  const $ = id => document.getElementById(id);
  const state = {
    status: null, market: null, universe: [], selected: null, stock: null,
    horizon: 1, range: 120, chart: "price", asof: "", rowsShown: 12,
    marketRequest: 0, stockRequest: 0, refreshing: false, lastChart: null,
    local: { connected: false, busy: false, phase: "checking", pending: false, message: "", token: null, progress: null, lastResult: null, checking: false },
  };
  const money = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  const number = new Intl.NumberFormat("zh-CN");
  const cleanDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const text = (id, value) => { $(id).textContent = value == null || value === "" ? "—" : String(value); };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const pct = (value, signed = true) => finite(value) ? `${signed && value > 0 ? "+" : ""}${(value * 100).toFixed(2)}%` : "—";
  const pp = value => finite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(2)}` : "—";
  const signClass = value => !finite(value) || value === 0 ? "" : value > 0 ? "up" : "down";
  const sign = value => value === 0 ? 0 : value > 0 ? 1 : -1;
  const dateLabel = value => cleanDate(value) ? value.replaceAll("-", ".") : "—";
  const marketLabel = value => ({ csi300: "CSI300 · 沪深300", csi500: "CSI500 · 中证500", us_proxy: "US · 美股研究代理", sp500_research_quote_candidate: "US · 美股研究股票池" }[String(value).toLowerCase()] || value);
  const statusValue = value => String(value || "").toLowerCase();
  const issueStates = new Set(["failed", "error", "stale", "partial", "unavailable"]);
  const statusIssue = value => issueStates.has(statusValue(value));
  const marketBehind = market => cleanDate(market?.expected_latest) && (!cleanDate(market?.as_of) || market.as_of < market.expected_latest);
  const symbolSlug = item => String(item.slug || item.symbol);
  const originLabel = source => ({ prospective: "事前存档", historical_replay: "历史回放", frozen_research: "冻结研究快照" }[source] || "来源待说明");
  const pathPart = value => encodeURIComponent(String(value));
  let toastTimer;
  let localPollTimer;
  const localService = "http://127.0.0.1:8766";
  const phaseLabels = { checking: "检查连接", idle: "可更新", queued: "准备更新", download: "获取行情", inference: "模型推理", publish: "发布结果", success: "本机已完成", error: "更新失败", offline: "服务未连接" };

  function yesterday() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const get = key => Number(parts.find(part => part.type === key).value);
    return new Date(Date.UTC(get("year"), get("month") - 1, get("day") - 1)).toISOString().slice(0, 10);
  }

  function displayTime(value) {
    if (!value) return "尚无记录";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(date) + "（北京时间）";
  }

  function notice(message = "") {
    $("notice").hidden = !message;
    $("notice").textContent = message;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4000);
  }

  function persist() {
    try { localStorage.setItem("factorbank-view-v1", JSON.stringify({ market: state.market?.id, symbol: state.selected?.symbol, horizon: state.horizon, range: state.range })); }
    catch (_) { /* Storage is optional (e.g. private browsing). */ }
  }

  function preferences() {
    try { return JSON.parse(localStorage.getItem("factorbank-view-v1") || "{}") || {}; }
    catch (_) { return {}; }
  }

  async function json(relative, force = false) {
    const url = new URL(relative, document.baseURI);
    if (force) url.searchParams.set("v", String(Date.now()));
    const response = await fetch(url, { cache: force ? "no-store" : "no-cache", credentials: "same-origin" });
    if (!response.ok) throw new Error(`结果文件尚未发布或暂时不可用（HTTP ${response.status}）：${relative}`);
    let result;
    try { result = await response.json(); }
    catch (_) { throw new Error(`结果文件不是有效 JSON：${relative}`); }
    if (!result || typeof result !== "object") throw new Error(`结果文件结构不正确：${relative}`);
    return result;
  }

  function showError(error, fatal = false) {
    $("error-panel").hidden = false;
    text("error-message", error instanceof Error ? error.message : error);
    $("stock-content").setAttribute("aria-busy", "false");
    if (fatal) {
      text("publish-status", "数据尚未就绪");
      $("publish-status").className = "status-chip error";
    }
  }

  function clearError() { $("error-panel").hidden = true; }

  function renderStatus() {
    const status = state.status;
    const refresh = status.refresh || {};
    const marketIssues = (status.markets || []).filter(market => statusIssue(market.status) || marketBehind(market));
    const isIssue = statusIssue(refresh.state) || statusIssue(status.status) || marketIssues.length > 0;
    text("publish-status", isIssue ? "部分结果待更新" : "已发布快照");
    $("publish-status").className = `status-chip${isIssue ? " stale" : ""}`;
    $("publish-status").title = `最新发布：${displayTime(status.generated_at)}`;
    text("updated-caption", `最近发布 ${displayTime(status.generated_at)} · 页面每10分钟检查新快照`);
    text("model-caption", `${status.model?.name || "共享固定权重模型"} · H1 / H5`);
    const model = status.model || {};
    const modelDetails = [model.name || "Two-Timescale FactorBank", model.version ? `版本 ${model.version}` : "", finite(model.parameters) ? `${number.format(model.parameters)} 参数` : "", finite(model.lookback) ? `回看 ${model.lookback} 个交易日` : ""].filter(Boolean);
    text("info-model", modelDetails.join(" · "));
    text("model-hash", status.model?.checkpoint_sha256 || "尚未发布校验值");
    if (isIssue) notice(`部分市场尚未取得最新完整行情，当前显示已经发布的可用结果。${refresh.message || "请核对各市场的实际数据截止日。"}`);
  }

  async function loadStatus(force = false, preserve = false) {
    clearError();
    const previous = state.market?.id;
    const status = await json("data/status.json", force);
    if (!Array.isArray(status.markets) || !status.markets.length) throw new Error("尚未发布任何市场面板，请先完成首次行情与模型结果发布。");
    state.status = status;
    renderStatus();
    const markets = status.markets.filter(item => item && typeof item.id === "string");
    if (!markets.length) throw new Error("市场清单缺少有效的市场标识。");
    $("market-select").replaceChildren(...markets.map(item => {
      const option = document.createElement("option"); option.value = item.id;
      const suffix = statusValue(item.status) === "unavailable" ? " · 暂无数据" : statusIssue(item.status) || marketBehind(item) ? " · 待更新" : "";
      option.textContent = (item.label || marketLabel(item.id)) + suffix; return option;
    }));
    $("market-select").disabled = false;
    const pref = preferences();
    const selectedId = preserve ? previous : pref.market;
    const market = markets.find(item => item.id === selectedId) || markets[0];
    $("market-select").value = market.id;
    await loadMarket(market.id, force, preserve);
  }

  async function loadMarket(id, force = false, preserve = false) {
    const request = ++state.marketRequest;
    ++state.stockRequest;
    clearError();
    state.market = state.status.markets.find(item => item.id === id);
    state.stock = null;
    $("stock-content").setAttribute("aria-busy", "true");
    $("stock-search").disabled = true;
    $("stock-search").value = "";
    $("asof-date").disabled = true;
    $("stock-list").innerHTML = '<div class="list-empty">正在读取观察名单…</div>';
    let data;
    try { data = await json(`data/universe/${pathPart(id)}.json`, force); }
    catch (error) { if (request !== state.marketRequest) return; throw error; }
    if (request !== state.marketRequest) return;
    const items = Array.isArray(data.symbols) ? data.symbols : [];
    state.universe = items.filter(item => item && typeof item.symbol === "string");
    text("universe-count", `${number.format(state.universe.length)} 只`);
    $("stock-search").disabled = false;
    const desired = preserve ? state.selected?.symbol : preferences().symbol;
    state.selected = state.universe.find(item => item.symbol === desired) || state.universe.find(item => ["current", "ok", "success"].includes(statusValue(item.status))) || state.universe.find(item => statusValue(item.status) !== "unavailable") || state.universe[0] || null;
    renderStockList();
    if (!state.selected) {
      resetStock("当前市场尚未发布可用股票");
      notice(state.market.message || "观察名单为空，请等待首次成功更新。");
      return;
    }
    await loadStock(force, preserve);
  }

  function renderStockList() {
    const query = $("stock-search").value.trim().toLocaleLowerCase();
    const filtered = state.universe.filter(item => `${item.symbol} ${item.name || ""} ${item.sector || ""}`.toLocaleLowerCase().includes(query));
    const list = $("stock-list");
    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("div"); empty.className = "list-empty";
      empty.textContent = query ? "没有找到匹配的股票" : "暂无股票";
      list.append(empty); return;
    }
    const fragment = document.createDocumentFragment();
    filtered.forEach(item => {
      const button = document.createElement("button");
      button.type = "button"; button.className = `stock-item${state.selected?.symbol === item.symbol ? " active" : ""}${statusIssue(item.status) ? " incomplete" : ""}`;
      button.setAttribute("aria-pressed", String(state.selected?.symbol === item.symbol));
      const lastDate = cleanDate(item.last_quote_date || item.last_date);
      const dataState = statusValue(item.status) === "unavailable" ? "暂无行情" : statusValue(item.status) === "stale" ? `行情至 ${dateLabel(lastDate)}` : "";
      button.title = `${item.symbol} ${item.name || ""}${dataState ? " · " + dataState : ""}`;
      const labels = document.createElement("span");
      const code = document.createElement("span"); code.className = "stock-symbol"; code.textContent = item.symbol;
      const name = document.createElement("span"); name.className = "stock-label"; name.textContent = item.name || "名称未提供";
      labels.append(code, name);
      if (dataState) { const marker = document.createElement("span"); marker.className = "stock-data-state"; marker.textContent = dataState; labels.append(marker); }
      button.append(labels);
      if (state.selected?.symbol === item.symbol) {
        const mark = document.createElement("span"); mark.className = "list-mark"; mark.setAttribute("aria-hidden", "true"); button.append(mark);
      }
      button.addEventListener("click", () => {
        if (state.selected?.symbol === item.symbol && state.stock) return;
        state.selected = item; state.rowsShown = 12; renderStockList();
        loadStock(false).catch(error => { resetStock("这只股票暂时没有可用结果"); showError(error); });
      });
      fragment.append(button);
    });
    list.append(fragment);
  }

  function normalizePrediction(row) {
    return {
      ...row,
      horizon: Number(row.horizon),
      origin_date: cleanDate(row.origin_date || row.decision_date),
      entry_date: cleanDate(row.entry_date || row.target_start),
      exit_date: cleanDate(row.exit_date || row.target_end),
    };
  }

  async function loadStock(force = false, preserveDate = false) {
    const request = ++state.stockRequest;
    clearError();
    $("stock-content").setAttribute("aria-busy", "true");
    $("asof-date").disabled = true;
    const market = state.market.id, selected = state.selected;
    text("stock-name", selected.name || selected.symbol);
    text("stock-code", selected.symbol);
    let data;
    try { data = await json(`data/stocks/${pathPart(market)}/${pathPart(symbolSlug(selected))}.json`, force); }
    catch (error) { if (request !== state.stockRequest) return; throw error; }
    if (request !== state.stockRequest) return;
    if (data.symbol && data.symbol !== selected.symbol) throw new Error("股票结果与所选代码不一致，已停止显示该文件。");
    if (data.market && data.market !== market) throw new Error("股票结果与所选市场不一致，已停止显示该文件。");
    const history = (Array.isArray(data.history) ? data.history : []).filter(row => cleanDate(row.date) && finite(row.close) && row.close > 0).sort((a, b) => a.date.localeCompare(b.date));
    const predictions = (Array.isArray(data.predictions) ? data.predictions : []).filter(row => row && [1, 5].includes(Number(row.horizon))).map(row => normalizePrediction({ ...row, source: row.source || data.source })).sort((a, b) => (a.exit_date || "").localeCompare(b.exit_date || "") || (a.origin_date || "").localeCompare(b.origin_date || ""));
    state.stock = { ...data, history, predictions };
    const caps = [yesterday(), cleanDate(state.market.as_of), cleanDate(data.as_of), history.at(-1)?.date].filter(Boolean);
    const maxDate = caps.sort()[0] || yesterday();
    const previous = state.asof;
    state.asof = preserveDate && previous && previous <= maxDate ? previous : maxDate;
    $("asof-date").max = maxDate;
    $("asof-date").min = history[0]?.date || "";
    $("asof-date").value = state.asof;
    $("asof-date").disabled = false;
    $("stock-content").setAttribute("aria-busy", "false");
    state.rowsShown = 12;
    renderStock(); persist();
  }

  function resetStock(message) {
    state.stock = null;
    $("stock-content").setAttribute("aria-busy", "false");
    ["predicted-return", "actual-return", "prediction-error", "evaluated-count", "mean-error", "direction-rate", "history-count"].forEach(id => text(id, "—"));
    text("prediction-window", message); text("actual-window", "实际结果可用后显示");
    text("direction-result", "预测收益 − 实际收益"); text("stock-meta", message);
    text("chart-empty", message); $("chart-empty").hidden = false;
    $("history-chart").replaceChildren();
    $("prediction-rows").innerHTML = `<tr><td colspan="7" class="table-empty">${esc(message)}</td></tr>`;
    $("show-more").hidden = true; $("source-tag").hidden = true;
  }

  function eligibleRows() {
    if (!state.stock) return [];
    return state.stock.predictions.filter(row => row.horizon === state.horizon && row.exit_date && row.exit_date <= state.asof && (!row.origin_date || row.origin_date < row.exit_date) && (!row.entry_date || row.entry_date < row.exit_date));
  }

  function renderStock() {
    if (!state.stock) return;
    const stock = state.stock;
    clearError();
    notice("");
    text("stock-name", stock.name || state.selected.name || stock.symbol || state.selected.symbol);
    text("stock-code", stock.symbol || state.selected.symbol);
    const quoteDate = cleanDate(stock.last_quote_date) || stock.history.at(-1)?.date;
    const stockState = statusValue(stock.status);
    const quoteState = stockState === "unavailable" ? "暂无有效行情" : quoteDate ? `最新报价 ${dateLabel(quoteDate)}${stockState === "stale" ? "（滞后）" : ""}` : "报价日期未说明";
    text("stock-meta", `${state.market.label || marketLabel(state.market.id)} · ${stock.currency || state.selected.currency || "报价币种未说明"} · ${stock.price_basis || "价格基准以数据说明为准"} · ${quoteState}`);
    text("cutoff-text", `行情截止 ${dateLabel(state.asof)} · 仅核对截止日前已到期的 H${state.horizon} 预测`);
    const rows = eligibleRows();
    const complete = rows.filter(row => finite(row.predicted_return) && finite(row.actual_return));
    const latest = [...rows].reverse().find(row => finite(row.predicted_return) && finite(row.actual_return)) || [...rows].reverse().find(row => finite(row.predicted_return));
    const selectedSource = latest?.source || stock.source;
    const tag = $("source-tag");
    tag.hidden = !selectedSource; tag.textContent = originLabel(selectedSource);
    tag.className = `source-tag${selectedSource === "prospective" ? " prospective" : ""}`;
    const messages = [];
    if (stock.message) messages.push(stock.message);
    if (state.market.message) messages.push(state.market.message);
    const marketActual = cleanDate(state.market.as_of), marketExpected = cleanDate(state.market.expected_latest);
    if (marketBehind(state.market)) messages.push(`市场按交易日历应更新至 ${dateLabel(marketExpected)}，当前实际仅至 ${dateLabel(marketActual)}；缺口期间不显示为已完整更新。`);
    if (stockState === "unavailable") messages.push("该股尚无有效免费行情，未用其他股票或模拟价格替代。");
    else if (stockState === "stale" || (quoteDate && marketActual && quoteDate < marketActual)) messages.push(`该股最后有效报价为 ${dateLabel(quoteDate)}，早于市场截止 ${dateLabel(marketActual)}；当前观察截止日已据实收窄，缺失日期不补成零收益。`);
    for (const [scope, record] of [["市场", state.market], ["该股", stock]]) {
      const missing = record.missing_sessions || record.missing_dates;
      const dates = Array.isArray(missing) ? missing.map(cleanDate).filter(Boolean) : [];
      if (dates.length) messages.push(`${scope}存在 ${dates.length} 个已确认缺失交易日：${dates.slice(0, 5).map(dateLabel).join("、")}${dates.length > 5 ? "等" : ""}；预测和实际收益仅按可核对记录展示。`);
    }
    if (selectedSource === "historical_replay") messages.push("当前核对的是历史回放：固定权重在历史可见输入上重算，不等同于当时已生成并存档的事前预测。");
    if (selectedSource === "frozen_research") messages.push("当前显示冻结研究快照，历史样本结果不代表最新市场的每日预测。");
    if (statusIssue(state.status.refresh?.state)) messages.push(`本次更新仅部分完成或存在异常，当前显示已发布的可用结果。${state.status.refresh.message || ""}`);
    notice([...new Set(messages)].join(" "));
    renderLatest(latest);
    const mae = complete.length ? complete.reduce((total, row) => total + Math.abs(row.predicted_return - row.actual_return), 0) / complete.length : null;
    const correct = complete.filter(row => sign(row.predicted_return) === sign(row.actual_return)).length;
    text("evaluated-count", `${number.format(complete.length)} 条`);
    text("mean-error", mae == null ? "—" : `${(mae * 100).toFixed(2)} 个百分点`);
    text("direction-rate", complete.length ? `${(100 * correct / complete.length).toFixed(1)}%` : "—");
    text("evaluation-note", `统计截至 ${dateLabel(state.asof)} 的全部 H${state.horizon} 已到期记录，不随行情图范围裁剪。缺失实际报价不计入，H5 重叠窗口不视为独立交易。`);
    renderTable(rows); renderChart();
  }

  function renderLatest(row) {
    ["predicted-return", "actual-return"].forEach(id => $(id).className = "metric-value");
    if (!row) {
      text("predicted-return", "—"); text("actual-return", "—"); text("prediction-error", "—");
      text("prediction-window", `截止日内暂无 H${state.horizon} 预测`);
      text("actual-window", "请选择其他截止日或股票"); text("direction-result", "尚无可核对结果");
      text("latest-context", "目标口径：决策日收盘后，下一交易日开盘入场，H1 / H5 个交易间隔后的开盘到期。");
      return;
    }
    text("predicted-return", pct(row.predicted_return));
    text("actual-return", pct(row.actual_return));
    $("predicted-return").classList.add(signClass(row.predicted_return) || "neutral");
    $("actual-return").classList.add(signClass(row.actual_return) || "neutral");
    text("prediction-window", `决策于 ${dateLabel(row.origin_date)}`);
    text("actual-window", `${dateLabel(row.entry_date)} — ${dateLabel(row.exit_date)} · 开盘到开盘`);
    const error = finite(row.predicted_return) && finite(row.actual_return) ? row.predicted_return - row.actual_return : null;
    $("prediction-error").innerHTML = `${esc(pp(error))}<span>百分点</span>`;
    text("direction-result", error == null ? "实际结果尚不可用" : `${sign(row.predicted_return) === sign(row.actual_return) ? "方向一致" : "方向不一致"} · ${error > 0 ? "高估" : error < 0 ? "低估" : "完全一致"}${error === 0 ? "" : ` ${Math.abs(error * 100).toFixed(2)} 个百分点`}`);
    const timestamps = row.created_at ? ` · 生成于 ${displayTime(row.created_at)}` : "";
    text("latest-context", `当前卡片：${dateLabel(row.origin_date)} 收盘决策，${dateLabel(row.entry_date)} 开盘入场，${dateLabel(row.exit_date)} 开盘到期；持有 ${state.horizon} 个交易间隔${timestamps}。`);
  }

  function renderTable(rows) {
    const sorted = [...rows].reverse();
    const visible = sorted.slice(0, state.rowsShown);
    text("records-count", `${number.format(sorted.length)} 条`);
    text("records-description", `H${state.horizon} 为 ${state.horizon} 个交易间隔的开盘到开盘累计收益，偏差保留正负方向。`);
    $("prediction-rows").innerHTML = visible.length ? visible.map(row => {
      const hasActual = finite(row.actual_return) && finite(row.predicted_return);
      const agree = hasActual && sign(row.predicted_return) === sign(row.actual_return);
      const error = hasActual ? row.predicted_return - row.actual_return : null;
      const label = !hasActual ? "报价未齐" : agree ? "方向一致" : "方向不一";
      const title = [originLabel(row.source), row.created_at ? `生成：${displayTime(row.created_at)}` : "", row.note || ""].filter(Boolean).join(" · ");
      return `<tr title="${esc(title)}"><td>${esc(dateLabel(row.origin_date))}<span class="row-source">${esc(originLabel(row.source))}</span></td><td>${esc(dateLabel(row.entry_date))}</td><td>${esc(dateLabel(row.exit_date))}</td><td class="numeric ${signClass(row.predicted_return)}">${esc(pct(row.predicted_return))}</td><td class="numeric ${signClass(row.actual_return)}">${esc(pct(row.actual_return))}</td><td class="numeric">${esc(pp(error))}</td><td><span class="result-tag${!hasActual ? " pending" : agree ? "" : " disagree"}">${esc(label)}</span></td></tr>`;
    }).join("") : '<tr><td colspan="7" class="table-empty">当前截止日内暂无可核对的预测。不会用模拟数字填充。</td></tr>';
    $("show-more").hidden = visible.length >= sorted.length;
    const sources = [...new Set(rows.map(row => originLabel(row.source)))];
    text("record-origin-note", sources.length ? `记录来源：${sources.join("、")}。逐条悬停可查看生成时间与说明。` : "首次成功生成结果后，此处将保留每条预测的真实来源。");
  }

  function svgElement(name, attrs = {}, content = null) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (content != null) element.textContent = String(content);
    return element;
  }

  function alignedPrice(row, historyMap) {
    if (!finite(row.predicted_return) || !finite(row.base_price) || row.base_price <= 0 || !row.entry_date || !row.exit_date) return null;
    const entry = historyMap.get(row.entry_date), exit = historyMap.get(row.exit_date);
    if (!finite(entry?.open) || entry.open <= 0 || !finite(exit?.open) || exit.open <= 0) return null;
    const closeEnough = (a, b) => Math.abs(a - b) <= Math.max(1e-5, Math.abs(b) * 1e-5);
    if (!closeEnough(row.base_price, entry.open)) return null;
    if (finite(row.actual_price) && !closeEnough(row.actual_price, exit.open)) return null;
    const predicted = row.base_price * (1 + row.predicted_return);
    if (!(predicted > 0) || (finite(row.predicted_price) && !closeEnough(row.predicted_price, predicted))) return null;
    return { predicted, actual: exit.open };
  }

  function renderChart() {
    const svg = $("history-chart");
    svg.replaceChildren(); $("chart-tooltip").hidden = true; state.lastChart = null;
    if (!state.stock) return;
    const allHistory = state.stock.history.filter(row => row.date <= state.asof);
    const historyMap = new Map(allHistory.map(row => [row.date, row]));
    const history = allHistory.slice(-state.range);
    const available = eligibleRows().filter(row => finite(row.predicted_return) && finite(row.actual_return));
    const byExit = new Map(available.map(row => [row.exit_date, row]));
    const price = state.chart === "price";
    let points;
    if (price) {
      points = history.map(row => {
        const prediction = byExit.get(row.date), aligned = prediction ? alignedPrice(prediction, historyMap) : null;
        return { date: row.date, close: row.close, predicted: aligned?.predicted ?? null, actual: aligned?.actual ?? null, prediction };
      });
    } else {
      points = available.slice(-state.range).map(row => ({ date: row.exit_date, close: null, predicted: row.predicted_return * 100, actual: row.actual_return * 100, prediction: row }));
    }
    const visiblePredictions = points.filter(row => finite(row.predicted));
    const count = points.length;
    text("history-count", `${number.format(count)} ${price ? "个交易日" : "条已到期预测"}`);
    $("chart-empty").hidden = !!count;
    text("chart-empty", price ? "截止日内尚无有效历史行情" : `截止日内暂无同时具有预测与实际收益的 H${state.horizon} 记录`);
    text("chart-heading", price ? "行情与到期预测" : "预测收益与实际收益");
    text("chart-description", price ? "历史收盘价作为行情背景；预测和实际到期开盘价单独标记。" : `逐次核对 H${state.horizon} 开盘到开盘收益；两条曲线差异即预测偏差。`);
    $("chart-legend").innerHTML = price ? '<span><i class="legend-line"></i>历史收盘</span><span><i class="legend-dot forecast"></i>预测到期开盘</span><span><i class="legend-dot actual"></i>实际到期开盘</span>' : '<span><i class="legend-line forecast"></i>预测收益</span><span><i class="legend-line actual"></i>实际收益</span>';
    text("chart-footnote", price ? (visiblePredictions.length ? "预测点由真实入场开盘价 × (1 + 预测收益) 换算；不是对该日收盘价的预测。" : "暂无可与入场/到期开盘价严格对齐的预测点，仅绘制真实历史收盘行情；收益可在下表核对。") : "以到期日对齐，单位为百分比。H5 窗口可能相互重叠，不代表独立的五日交易。");
    if (!count) return;
    const stage = $("chart-stage").getBoundingClientRect();
    const width = Math.max(280, stage.width), height = Math.max(240, stage.height);
    const pad = { left: width < 500 ? 52 : 67, right: 18, top: 22, bottom: 41 };
    const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom;
    const values = points.flatMap(row => [row.close, row.predicted, row.actual]).filter(finite);
    if (!values.length) return;
    let min = Math.min(...values), max = Math.max(...values);
    if (!price) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const span = max - min || Math.max(Math.abs(max) * .08, price ? .1 : .5);
    min -= span * .13; max += span * .13;
    const x = index => pad.left + (count > 1 ? index / (count - 1) : .5) * innerW;
    const y = value => pad.top + (max - value) / (max - min) * innerH;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-label", `${state.selected.symbol} H${state.horizon} ${price ? "真实收盘行情与预测到期开盘价" : "预测和实际收益对照"}，截止${state.asof}，${count}条记录`);
    const defs = svgElement("defs"), gradient = svgElement("linearGradient", { id: "price-fill", x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.append(svgElement("stop", { offset: "0%", "stop-color": "#345d78", "stop-opacity": ".08" }), svgElement("stop", { offset: "100%", "stop-color": "#345d78", "stop-opacity": "0" }));
    defs.append(gradient); svg.append(defs);
    for (let index = 0; index <= 4; index++) {
      const value = min + (max - min) * index / 4, yy = y(value);
      svg.append(svgElement("line", { x1: pad.left, y1: yy, x2: width - pad.right, y2: yy, stroke: "#e8eef2", "stroke-width": 1 }));
      svg.append(svgElement("text", { x: pad.left - 11, y: yy + 4, "text-anchor": "end", fill: "#7b8d9c", "font-size": 14, "font-family": "inherit" }, price ? money.format(value) : `${value.toFixed(1)}%`));
    }
    const labels = Math.min(width < 500 ? 3 : 5, count);
    for (let index = 0; index < labels; index++) {
      const at = labels === 1 ? 0 : Math.round(index * (count - 1) / (labels - 1));
      svg.append(svgElement("text", { x: x(at), y: height - 13, "text-anchor": index === 0 ? "start" : index === labels - 1 ? "end" : "middle", fill: "#7b8d9c", "font-size": 14, "font-family": "inherit" }, points[at].date.slice(5).replace("-", ".")));
    }
    if (!price && min < 0 && max > 0) svg.append(svgElement("line", { x1: pad.left, y1: y(0), x2: width - pad.right, y2: y(0), stroke: "#bbcbd5", "stroke-dasharray": "4 5" }));
    function line(key, color, area = false) {
      let d = "", active = false;
      points.forEach((point, index) => {
        if (!finite(point[key])) { active = false; return; }
        d += `${active ? "L" : "M"}${x(index).toFixed(2)},${y(point[key]).toFixed(2)} `; active = true;
      });
      if (!d) return;
      if (area && points.every(point => finite(point[key]))) svg.append(svgElement("path", { d: `${d}L${x(count - 1)},${height - pad.bottom} L${x(0)},${height - pad.bottom}Z`, fill: "url(#price-fill)" }));
      svg.append(svgElement("path", { d, fill: "none", stroke: color, "stroke-width": price ? 2 : 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "vector-effect": "non-scaling-stroke" }));
    }
    if (price) {
      line("close", "#34556c", true);
      points.forEach((point, index) => {
        if (finite(point.predicted)) {
          svg.append(svgElement("line", { x1: x(index), y1: y(point.predicted), x2: x(index), y2: y(point.actual), stroke: "#e9d4bf", "stroke-width": 1, "stroke-dasharray": "2 3" }));
          svg.append(svgElement("circle", { cx: x(index), cy: y(point.actual), r: 2.8, fill: "#fff", stroke: "#087f7c", "stroke-width": 1.5 }));
          svg.append(svgElement("circle", { cx: x(index), cy: y(point.predicted), r: 2.8, fill: "#d77838", stroke: "#fff", "stroke-width": .7 }));
        }
      });
    } else { line("actual", "#087f7c"); line("predicted", "#d77838"); }
    const crosshair = svgElement("line", { x1: 0, x2: 0, y1: pad.top, y2: height - pad.bottom, stroke: "#91a9b7", "stroke-width": 1, "stroke-dasharray": "3 4", visibility: "hidden", id: "chart-crosshair" });
    svg.append(crosshair);
    state.lastChart = { points, width, height, pad, innerW, x, price };
  }

  function showChartTooltip(event) {
    const chart = state.lastChart;
    if (!chart) return;
    const bounds = $("history-chart").getBoundingClientRect();
    const local = (event.clientX - bounds.left) * chart.width / bounds.width;
    const index = Math.max(0, Math.min(chart.points.length - 1, Math.round((local - chart.pad.left) / chart.innerW * (chart.points.length - 1))));
    const point = chart.points[index], prediction = point.prediction;
    const crosshair = document.getElementById("chart-crosshair");
    crosshair?.setAttribute("x1", String(chart.x(index))); crosshair?.setAttribute("x2", String(chart.x(index))); crosshair?.setAttribute("visibility", "visible");
    const tooltip = $("chart-tooltip");
    let html = `<div class="tooltip-date">${esc(dateLabel(point.date))}</div>`;
    const row = (label, value, color = "") => `<div class="tooltip-row"><span>${esc(label)}</span><strong${color ? ` style="color:${color}"` : ""}>${esc(value)}</strong></div>`;
    if (chart.price) {
      html += row("历史收盘", finite(point.close) ? money.format(point.close) : "—");
      if (finite(point.predicted)) { html += row("预测到期开盘", money.format(point.predicted), "#b86d35") + row("实际到期开盘", money.format(point.actual), "#087f7c"); }
      else html += row("价格预测点", "基准未对齐或尚无记录");
    } else { html += row("预测收益", pct(point.predicted / 100), "#b86d35") + row("实际收益", pct(point.actual / 100), "#087f7c"); }
    if (prediction) html += row("决策日", dateLabel(prediction.origin_date)) + row("来源", originLabel(prediction.source));
    tooltip.innerHTML = html; tooltip.hidden = false;
    const stageBounds = $("chart-stage").getBoundingClientRect();
    const tooltipWidth = tooltip.getBoundingClientRect().width;
    const left = Math.max(2, Math.min(event.clientX - stageBounds.left + 14, stageBounds.width - tooltipWidth - 3));
    tooltip.style.left = `${left}px`; tooltip.style.top = "15px";
  }

  function buttons(group, key, value) {
    document.querySelectorAll(group).forEach(button => {
      const active = String(button.dataset[key]) === String(value);
      button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
    });
  }

  async function refresh(force = true) {
    if (state.refreshing) return;
    state.refreshing = true;
    const button = $("refresh-button"); button.disabled = true; button.classList.add("refreshing");
    const old = state.status?.generated_at;
    try {
      await loadStatus(force, true);
      toast(old && old === state.status.generated_at ? "已重新读取当前发布快照，尚无更新版本" : "最新发布结果已载入");
    } catch (error) { showError(error, !state.status); }
    finally { state.refreshing = false; button.disabled = false; button.classList.remove("refreshing"); }
  }

  function renderLocalService() {
    const service = state.local;
    const phase = service.phase || "idle";
    const status = $("local-service-state");
    status.textContent = phaseLabels[phase] || (service.busy ? "处理中" : "已连接");
    status.className = `service-state ${service.connected ? service.busy ? "busy" : phase === "error" ? "error" : "ready" : phase === "checking" ? "checking" : "offline"}`;
    const button = $("update-button");
    button.disabled = service.pending || service.busy;
    button.setAttribute("aria-busy", String(service.pending || service.busy));
    button.querySelector("span").textContent = service.pending ? "正在连接本机" : service.busy ? phaseLabels[phase] || "正在更新" : "更新数据并预测";
    $("connect-service").disabled = service.pending || service.checking;
    text("schedule-summary", phase === "checking" ? "正在检查服务连接" : service.connected ? service.busy ? `当前：${phaseLabels[phase] || "处理中"}` : "已连接 · 点击按钮更新" : "未连接 · 请启动 PyCharm 服务");
    const defaultMessage = phase === "checking" ? "正在连接模型所在电脑的本机服务；已发布结果可独立查看。" : service.connected ? service.busy ? "正在本机处理，完成后将发布更新结果。" : "本机服务已连接。点击“更新数据并预测”获取增量行情、运行当前模型并发布。" : "无法连接本机更新服务。已发布的历史结果仍可查看；请启动模型所在电脑的 PyCharm 服务后重试。";
    let message = service.message || defaultMessage;
    if (phase === "success") message += service.lastResult?.site_visible ? " 已确认网页发布，正在载入最新结果。" : " 本机流程已完成；以网页实际发布时刻为准。";
    text("local-service-message", message);
    $("local-service-help").hidden = service.connected && phase !== "error";
    $("local-service-progress").hidden = !service.busy;
    let progress = service.progress;
    if (progress && typeof progress === "object") {
      progress = finite(progress.percent) ? progress.percent : finite(progress.current) && finite(progress.total) && progress.total > 0 ? progress.current / progress.total * 100 : null;
    }
    if (finite(progress)) {
      $("update-progress").value = Math.max(0, Math.min(100, progress));
      text("update-progress-label", `${phaseLabels[phase] || "处理中"} · ${Math.round(Math.max(0, Math.min(100, progress)))}%`);
    } else {
      $("update-progress").removeAttribute("value");
      text("update-progress-label", phaseLabels[phase] || "处理中");
    }
  }

  async function localJson(endpoint, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.method === "POST" ? 15000 : 5000);
    try {
      const response = await fetch(localService + endpoint, { mode: "cors", credentials: "omit", cache: "no-store", ...options, signal: controller.signal });
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error("本机服务返回了无法识别的结果，请核对 PyCharm 中的服务窗口。"); }
      if (!response.ok) throw new Error(data.message || data.error || `本机请求未完成（HTTP ${response.status}）。`);
      if (!data || typeof data !== "object") throw new Error("本机服务返回格式不正确。");
      return data;
    } finally { clearTimeout(timer); }
  }

  function acceptLocalStatus(data) {
    if (typeof data.service !== "string" || !data.service.toLowerCase().includes("factorbank")) throw new Error("此端口不是 FactorBank 更新服务，请使用指定的 PyCharm 运行配置。");
    const wasBusy = state.local.busy;
    state.local.connected = true;
    state.local.busy = Boolean(data.busy);
    state.local.phase = typeof data.phase === "string" ? data.phase.toLowerCase() : data.busy ? "queued" : "idle";
    state.local.progress = data.progress;
    state.local.message = typeof data.message === "string" ? data.message : "";
    state.local.lastResult = data.last_result || null;
    // The CSRF value is retained only in this closure's memory, never in storage or URLs.
    state.local.token = typeof data.csrf_token === "string" ? data.csrf_token : null;
    renderLocalService();
    if (wasBusy && !state.local.busy && state.local.phase === "success") {
      toast("网页已发布，正在加载最新预测结果");
      refresh(true);
    }
  }

  function localOffline(error) {
    const wasBusy = state.local.busy;
    state.local.connected = false; state.local.busy = false; state.local.phase = "offline";
    state.local.token = null; state.local.progress = null;
    const details = error instanceof Error && error.name !== "AbortError" && error.name !== "TypeError" ? error.message : "";
    state.local.message = wasBusy ? "与本机服务的连接中断，任务状态暂时无法确认。请恢复连接后查看，避免重复启动。" : details || "本机服务未连接。请在模型所在电脑启动 PyCharm 的“Dashboard - local update service”，再点击重新连接。浏览器若询问本地网络权限，请允许此网页连接本机。";
    renderLocalService();
  }

  async function checkLocalService() {
    if (state.local.checking) return;
    clearTimeout(localPollTimer);
    state.local.checking = true; renderLocalService();
    try { acceptLocalStatus(await localJson("/api/status")); }
    catch (error) { localOffline(error); }
    finally {
      state.local.checking = false; renderLocalService();
      if (state.local.connected && state.local.busy) localPollTimer = setTimeout(checkLocalService, 3000);
    }
  }

  async function requestLocalUpdate() {
    if (state.local.pending || state.local.busy) return;
    clearTimeout(localPollTimer);
    state.local.pending = true; renderLocalService();
    try {
      acceptLocalStatus(await localJson("/api/status"));
      if (state.local.busy) return;
      const token = state.local.token;
      if (!token) throw new Error("本机服务没有返回安全校验值，请重新连接后再试。");
      const result = await localJson("/api/update", { method: "POST", headers: { "Content-Type": "application/json", "X-FactorBank-Token": token }, body: JSON.stringify({ csrf_token: token }) });
      state.local.busy = true; state.local.phase = "queued";
      state.local.message = typeof result.message === "string" ? result.message : "更新请求已交给本机服务；正在准备增量行情、模型推理与结果发布。";
      state.local.progress = null;
      toast("更新已启动，可在此查看本机处理进度");
    } catch (error) {
      if (!state.local.connected || error.name === "AbortError" || error.name === "TypeError") localOffline(error);
      else { state.local.phase = "error"; state.local.message = error.message; renderLocalService(); }
    } finally {
      state.local.pending = false; renderLocalService();
      if (state.local.connected && state.local.busy) localPollTimer = setTimeout(checkLocalService, 1000);
    }
  }

  $("market-select").addEventListener("change", event => {
    loadMarket(event.target.value).catch(error => { resetStock("当前市场结果未就绪"); showError(error); });
  });
  $("stock-search").addEventListener("input", renderStockList);
  $("asof-date").addEventListener("change", event => {
    const value = cleanDate(event.target.value);
    if (!value || value > event.target.max || (event.target.min && value < event.target.min)) {
      event.target.value = state.asof; toast("请选择行情范围内的已收盘日期"); return;
    }
    state.asof = value; state.rowsShown = 12; renderStock();
  });
  document.querySelectorAll("[data-horizon]").forEach(button => button.addEventListener("click", () => {
    state.horizon = Number(button.dataset.horizon); state.rowsShown = 12;
    buttons("[data-horizon]", "horizon", state.horizon); renderStock(); persist();
  }));
  document.querySelectorAll("[data-range]").forEach(button => button.addEventListener("click", () => {
    state.range = Number(button.dataset.range); buttons("[data-range]", "range", state.range); renderChart(); persist();
  }));
  document.querySelectorAll("[data-chart]").forEach(button => button.addEventListener("click", () => {
    state.chart = button.dataset.chart; buttons("[data-chart]", "chart", state.chart); renderChart();
  }));
  $("show-more").addEventListener("click", () => { state.rowsShown += 30; renderTable(eligibleRows()); });
  $("refresh-button").addEventListener("click", () => refresh(true));
  $("retry-button").addEventListener("click", () => refresh(true));
  $("update-button").addEventListener("click", requestLocalUpdate);
  $("connect-service").addEventListener("click", checkLocalService);
  $("model-info").addEventListener("click", () => $("info-dialog").showModal());
  $("close-info").addEventListener("click", () => $("info-dialog").close());
  $("info-dialog").addEventListener("click", event => { if (event.target === $("info-dialog")) { const b = event.target.getBoundingClientRect(); if (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom) event.target.close(); } });
  $("history-chart").addEventListener("pointermove", showChartTooltip);
  $("history-chart").addEventListener("pointerleave", () => { $("chart-tooltip").hidden = true; document.getElementById("chart-crosshair")?.setAttribute("visibility", "hidden"); });
  document.addEventListener("keydown", event => {
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) && !$("info-dialog").open) { event.preventDefault(); $("stock-search").focus(); }
  });
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 100); });
  setInterval(async () => {
    if (document.hidden || state.refreshing || !state.status) return;
    try { const status = await json("data/status.json", true); if (status.generated_at !== state.status.generated_at) await refresh(true); }
    catch (_) { /* Preserve an already rendered snapshot on a transient outage. */ }
  }, 10 * 60 * 1000);

  const pref = preferences();
  state.horizon = [1, 5].includes(Number(pref.horizon)) ? Number(pref.horizon) : 1;
  state.range = [60, 120, 250].includes(Number(pref.range)) ? Number(pref.range) : 120;
  buttons("[data-horizon]", "horizon", state.horizon); buttons("[data-range]", "range", state.range);
  loadStatus().catch(error => { resetStock("等待首次成功发布真实结果"); showError(error, true); });
  checkLocalService();
})();
