// Token Radar dashboard: board, live view, method, and per-protocol detail.
// No network: every byte comes from data.js. Farm plans are generated here,
// in the page, from each row's own record — the same derivation the model
// runs server-side, so the screen and the board always agree.

const D = window.RADAR;
const $ = (id) => document.getElementById(id);
const watchSet = new Set(D.watchlist);

const money = (n) => {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n;
};
const pct = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
const ageText = (d) => (d === null || d === undefined ? '—' : d < 365 ? d + 'd' : (d / 365).toFixed(1) + 'y');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- masthead stats -------------------------------------------------------
$('mastStats').innerHTML =
  stat(D.board_size, 'rows ranked') +
  stat(D.watchlist_size, 'watchlist') +
  stat(D.live_size, 'live tokens') +
  stat(D.as_of, 'snapshot date');
function stat(b, label) {
  return '<div class="stat"><b>' + esc(b) + '</b><span>' + esc(label) + '</span></div>';
}

// ---- tabs -----------------------------------------------------------------
$('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  showView(btn.dataset.view);
});
function showView(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + name));
}

// ---- filters ---------------------------------------------------------------
const cats = [...new Set(D.rows.map((r) => r.category).filter(Boolean))].sort();
const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
for (const c of cats) $('cat').append(new Option(c, c));
for (const c of chains) $('chain').append(new Option(c, c));

let sortKey = 'rank';
$('sort').addEventListener('change', (e) => { sortKey = e.target.value; render(); });
['q', 'cat', 'chain', 'watch'].forEach((id) => $(id).addEventListener('input', render));

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('cat').value;
  const chain = $('chain').value;
  const watch = $('watch').checked;
  let rows = D.rows.filter((r) =>
    (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
    (!cat || r.category === cat) &&
    (!chain || r.chains.includes(chain)) &&
    (!watch || watchSet.has(r.slug)));
  const key = {
    rank: (a, b) => a.rank - b.rank,
    implied: (a, b) => b.implied_value_usd - a.implied_value_usd,
    tvl: (a, b) => b.tvl_usd - a.tvl_usd,
    growth: (a, b) => (b.change_7d ?? -999) - (a.change_7d ?? -999),
  }[sortKey];
  return rows.sort(key);
}

function rowHtml(r) {
  const g = r.change_7d;
  const cls = g === null ? '' : g >= 0 ? 'up' : 'down';
  const watch = watchSet.has(r.slug) ? ' <span class="tag watch">watchlist</span>' : '';
  return '<tr data-slug="' + esc(r.slug) + '">' +
    '<td>' + r.rank + '</td>' +
    '<td><b>' + esc(r.name) + '</b><span class="sub">' + esc(r.slug) + '</span>' + watch + '</td>' +
    '<td>' + esc(r.category || '—') + '</td>' +
    '<td>' + esc(r.chains.join(', ') || '—') + '</td>' +
    '<td class="num">' + money(r.tvl_usd) + '</td>' +
    '<td class="num ' + cls + '">' + pct(g) + '</td>' +
    '<td class="num">' + ageText(r.age_days) + '</td>' +
    '<td class="num"><b>' + money(r.implied_value_usd) + '</b></td>' +
    '<td>›</td></tr>';
}

function render() {
  const rows = filtered();
  $('rows').innerHTML = rows.map(rowHtml).join('');
  $('count').textContent = rows.length + ' of ' + D.rows.length + ' rows';
}

// ---- farm plans, generated in the page ------------------------------------
function capitalFor(tvl) {
  if (tvl >= 5e9) return 250;
  if (tvl >= 1e9) return 150;
  if (tvl >= 1e8) return 100;
  return 50;
}
function holdFor(age) {
  if (age === null || age === undefined) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}
function actionFor(r, capital) {
  const c = (r.category || '').toLowerCase();
  const chain = r.chains[0] || 'its main chain';
  const n = r.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Lend $' + capital + ' of USDC on ' + n + ' (' + chain + ') and leave the loan open.';
  if (c.includes('dex')) return 'Add $' + capital + ' of liquidity to ' + n + "'s deepest pool on " + chain + ' and leave it in.';
  if (c.includes('yield') || c.includes('leveraged farm')) return 'Put $' + capital + " into " + n + "'s main yield position on " + chain + ' and keep it running.';
  if (c.includes('bridge')) return 'Bridge $' + capital + ' of USDC onto ' + chain + ' through ' + n + ', then use the bridged funds inside its app.';
  if (c.includes('staking') || c.includes('restak')) return 'Stake $' + capital + ' of the chain asset through ' + n + ' on ' + chain + ' and hold the receipt token.';
  if (c.includes('perpetual') || c.includes('derivative')) return 'Post $' + capital + ' of USDC as margin on ' + n + ' and open one small hedged trade.';
  if (c.includes('prediction')) return 'Fund $' + capital + ' on ' + n + ' and take one market position.';
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return 'Deposit $' + capital + ' into a ' + n + ' vault on ' + chain + ' and hold the shares.';
  if (c.includes('stable')) return 'Mint or deposit $' + capital + ' of the stable asset through ' + n + ' on ' + chain + '.';
  if (c.includes('rwa')) return 'Mint $' + capital + ' of the yield-bearing asset ' + n + ' issues on ' + chain + ' and hold it.';
  if (c.includes('insurance')) return 'Buy $' + capital + ' of cover from ' + n + ' on ' + chain + ' and keep the policy live.';
  if (c.includes('nft') || c.includes('gaming')) return 'Use $' + capital + ' inside ' + n + ' on ' + chain + ': play, mint or trade through its own app, not a marketplace.';
  return 'Deposit $' + capital + ' of USDC into ' + n + ' on ' + chain + ' and keep the position open.';
}
function farmSteps(r) {
  const capital = capitalFor(r.tvl_usd);
  const hold = holdFor(r.age_days);
  const gas = capital >= 150 ? 8 : 4;
  const steps = [
    ['Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', 'under $3 of gas for the first transaction', '5 minutes'],
    [actionFor(r, capital), '$' + capital + ' of capital and about $' + gas + ' of gas', '15 minutes to set up'],
    ['Do one qualifying action every week — a deposit, a borrow, a swap or a vote — so the wallet reads as active.', 'about $2 of gas a week', '10 minutes a week'],
    ['Hold the position for at least ' + hold + ' days, so the activity lands in more than one snapshot.', 'the $' + capital + ' stays in the position', hold + ' days'],
    ["Before withdrawing, open the protocol's own points or rewards page and claim only through the link it publishes.", 'no fee to check, and never pay to claim', '10 minutes'],
    ['Log the wallet, the dates and every transaction, so you can repeat the position or unwind it cleanly.', 'nothing but the log', '5 minutes'],
  ];
  return steps.map(([t, c, tm]) => '<li>' + esc(t) + ' <b>Cost: ' + esc(c) + '. Time: ' + esc(tm) + '.</b></li>').join('');
}

// ---- detail view ------------------------------------------------------------
function openDetail(slug) {
  const r = D.rows.find((x) => x.slug === slug);
  if (!r) return;
  document.querySelectorAll('#rows tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.slug === slug));
  $('detailBody').innerHTML =
    '<div class="tag' + (watchSet.has(r.slug) ? ' watch' : '') + '">' + (watchSet.has(r.slug) ? 'WATCHLIST' : 'EARLY FIND') + '</div>' +
    '<h2>' + esc(r.name) + '</h2>' +
    '<div class="meta">Rank #' + r.rank + ' · ' + esc(r.category || 'uncategorised') + ' · ' + esc(r.chains.join(', ') || '—') + '</div>' +
    '<p><span class="big">' + money(r.implied_value_usd) + '</span><br><span class="meta">implied value if a token shipped on this record</span></p>' +
    '<h3>Model breakdown</h3>' +
    '<table><tbody>' +
    '<tr><td>TVL</td><td class="num">' + money(r.tvl_usd) + '</td></tr>' +
    '<tr><td>Category multiple</td><td class="num">×' + r.category_multiple.toFixed(4) + '</td></tr>' +
    '<tr><td>Growth (7d ' + pct(r.change_7d) + ')</td><td class="num">×' + r.growth_multiplier.toFixed(4) + '</td></tr>' +
    '<tr><td>Maturity (' + ageText(r.age_days) + ')</td><td class="num">×' + r.maturity_multiplier.toFixed(4) + '</td></tr>' +
    '<tr><td>Breadth (' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ')</td><td class="num">×' + r.breadth_multiplier.toFixed(4) + '</td></tr>' +
    '<tr><td>Listed</td><td class="num">' + esc(r.listed_at || 'unknown') + '</td></tr>' +
    '</tbody></table>' +
    '<h3>Farm plan</h3><ol>' + farmSteps(r) + '</ol>' +
    '<p class="meta">Implied value is this entry\u2019s claim about worth, not a prediction that a token ships, or when. The protocol records no token in the snapshot.</p>';
  $('detail').hidden = false;
}
function closeDetail() {
  $('detail').hidden = true;
  document.querySelectorAll('#rows tr.sel').forEach((tr) => tr.classList.remove('sel'));
}
$('rows').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-slug]');
  if (tr) openDetail(tr.dataset.slug);
});
$('closeDetail').addEventListener('click', closeDetail);

// ---- live view ---------------------------------------------------------------
$('liveRows').innerHTML = D.live.map((p, i) =>
  '<tr><td>' + (i + 1) + '</td><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.category || '—') + '</td>' +
  '<td>' + esc(p.chains.join(', ') || '—') + '</td><td class="num">' + money(p.tvl_usd) + '</td>' +
  '<td class="num">' + money(p.mcap_usd || 0) + '</td><td class="num">' + pct(p.change_7d) + '</td></tr>').join('');

// ---- deep links, so a screenshot can open one state ---------------------------
function applyDeepLink() {
  const h = new URLSearchParams(location.hash.slice(1));
  const s = new URLSearchParams(location.search);
  const detail = h.get('detail') || s.get('detail');
  const cat = h.get('category') || s.get('category');
  if (cat) { $('cat').value = cat; }
  if (h.get('watch') === '1' || s.get('watch') === '1') { $('watch').checked = true; }
  render();
  if (detail) openDetail(detail);
}
render();
applyDeepLink();
