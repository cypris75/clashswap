/**
 * ClashSwap front end. No framework, no build step — just modules.
 * Every value that comes from the API is inserted as text, never as HTML.
 */

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const state = {
  cards: null,
  byId: new Map(),
  categories: {},
  clanId: null,
  data: null,
  me: null, // member id of whoever is using this browser
  tab: 'cards',
  scope: 'mine', // trades tab: 'mine' | 'all'
  loading: false,
  pending: new Map(), // cardId -> timer, while a save is in flight
  myCounts: {},
};

// --- tiny DOM helper --------------------------------------------------------

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const cardIcon = (cardId, size = 54) => {
  const card = state.byId.get(cardId);
  return h('img', {
    src: card ? card.icon : '',
    alt: card ? card.name : '',
    width: size,
    height: size,
    loading: 'lazy',
    decoding: 'async',
  });
};

const cardName = (cardId) => state.byId.get(cardId)?.name ?? `Card ${cardId}`;

// --- storage ----------------------------------------------------------------

const store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode — the app still works, it just forgets */
    }
  },
  identity(clanId) {
    return this.read(`clashswap.me.${clanId}`, null);
  },
  setIdentity(clanId, member) {
    if (member) this.write(`clashswap.me.${clanId}`, member);
    else localStorage.removeItem(`clashswap.me.${clanId}`);
  },
  recents() {
    return this.read('clashswap.clans', []);
  },
  remember(clan) {
    const list = this.recents().filter((c) => c.id !== clan.id);
    list.unshift({ id: clan.id, name: clan.name, seenAt: Date.now() });
    this.write('clashswap.clans', list.slice(0, 8));
  },
  doneTrades(clanId) {
    return new Set(this.read(`clashswap.done.${clanId}`, []));
  },
  setDone(clanId, set) {
    this.write(`clashswap.done.${clanId}`, [...set]);
  },
};

// --- api --------------------------------------------------------------------

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

let toastTimer;
function toast(message, kind = 'ok') {
  toastEl.textContent = message;
  toastEl.className = `toast${kind === 'error' ? ' error' : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, kind === 'error' ? 4200 : 2200);
}

// --- routing ----------------------------------------------------------------

function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  route();
}

window.addEventListener('popstate', () => route());

async function route() {
  const match = location.pathname.match(/^\/c\/([0-9a-f-]{36})/i);
  if (match) {
    state.clanId = match[1];
    await loadClan();
  } else {
    state.clanId = null;
    state.data = null;
    renderLanding();
  }
}

// --- landing ----------------------------------------------------------------

function renderLanding() {
  const heroCards = [1, 24, 40].map((id) => cardIcon(id, 84));

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (event) => {
        event.preventDefault();
        const input = form.querySelector('input');
        const button = form.querySelector('button');
        const name = input.value.trim();
        if (!name) return input.focus();
        button.disabled = true;
        try {
          const { clan } = await api('/clans', { method: 'POST', body: { name } });
          store.remember(clan);
          navigate(`/c/${clan.id}`);
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'clan-name', text: 'Clan name' }),
      h('input', {
        class: 'input',
        id: 'clan-name',
        name: 'name',
        maxlength: '60',
        placeholder: 'e.g. Ritter der Nacht',
        autocomplete: 'off',
      }),
    ),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create the board'),
  );

  const recents = store.recents();

  render(
    h(
      'div',
      { class: 'shell' },
      h(
        'header',
        { class: 'hero' },
        h('div', { class: 'hero-fan' }, ...heroCards, h('div', { class: 'seal', text: '⇄' })),
        h('h1', { text: 'ClashSwap' }),
        h('p', {
          class: 'lede',
          text: 'Everyone in the clan lists the cards they pulled. ClashSwap works out who should swap what with whom — so no duplicate goes to waste.',
        }),
      ),
      h(
        'div',
        { class: 'panel' },
        h('p', { class: 'eyebrow', text: 'Start a board' }),
        h('h2', { text: 'One link for the whole clan', style: 'margin:6px 0 14px' }),
        form,
        h('p', {
          class: 'muted',
          style: 'font-size:.84rem;margin-top:12px',
          text: 'You get a private link with a random ID. Anyone who has it can join and enter their cards — no accounts, no passwords.',
        }),
      ),
      recents.length
        ? h(
            'section',
            { style: 'margin-top:24px' },
            h('p', { class: 'eyebrow', text: 'Your boards' }),
            h(
              'div',
              { class: 'recent', style: 'margin-top:10px' },
              ...recents.map((c) =>
                h(
                  'a',
                  {
                    href: `/c/${c.id}`,
                    onclick: (e) => {
                      e.preventDefault();
                      navigate(`/c/${c.id}`);
                    },
                  },
                  h('span', { style: 'font-weight:800;color:var(--parchment)', text: c.name }),
                  h('span', { text: 'Open →' }),
                ),
              ),
            ),
          )
        : null,
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, h('span', { text: 'Create the board and share the link in your clan chat.' })),
        h('li', {}, h('span', { text: 'Everyone taps in how many copies they hold of each card.' })),
        h('li', {}, h('span', { text: 'The trade plan updates itself: who swaps which card with whom.' })),
      ),
      h('p', { class: 'footer-note', text: 'Card art belongs to Supercell. ClashSwap is a fan-made helper.' }),
    ),
  );
}

// --- clan loading -----------------------------------------------------------

async function loadClan({ quiet = false } = {}) {
  if (!quiet) {
    state.loading = true;
    render(
      h(
        'div',
        { class: 'loading' },
        h('div', { class: 'seal', text: '⇄' }),
        h('p', { text: 'Opening the board…' }),
      ),
    );
  }

  try {
    const data = await api(`/clans/${state.clanId}`);

    // A background poll that brings back identical data must not redraw the
    // page — that would throw away the user's scroll position mid-scroll.
    const fingerprint = JSON.stringify({ clan: data.clan, members: data.members });
    if (quiet && state.data && fingerprint === state.fingerprint) return;
    state.fingerprint = fingerprint;

    state.data = data;
    state.loading = false;
    store.remember(data.clan);

    const saved = store.identity(state.clanId);
    const stillThere = saved && data.members.find((m) => m.id === saved.id);
    state.me = stillThere ? saved.id : null;
    if (saved && !stillThere) store.setIdentity(state.clanId, null);

    // Local counts stay authoritative while the user is tapping.
    if (state.me && state.pending.size === 0) {
      state.myCounts = { ...(data.members.find((m) => m.id === state.me)?.counts || {}) };
    }
    renderClan();
  } catch (err) {
    state.loading = false;
    render(
      h(
        'div',
        { class: 'shell' },
        h(
          'div',
          { class: 'empty', style: 'margin-top:60px' },
          h('b', { text: 'This board is not available' }),
          h('p', { text: err.message }),
          h(
            'p',
            { style: 'margin-top:14px' },
            h(
              'button',
              { class: 'btn', onclick: () => navigate('/') },
              '← Back to the start',
            ),
          ),
        ),
      ),
    );
  }
}

let refreshTimer;
function scheduleRefresh(delay = 700) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadClan({ quiet: true }), delay);
}

setInterval(() => {
  if (state.clanId && !document.hidden && state.pending.size === 0) loadClan({ quiet: true });
}, 25_000);

// --- clan view --------------------------------------------------------------

function renderClan() {
  const { clan, members, plan } = state.data;
  const me = members.find((m) => m.id === state.me) || null;
  const myTrades = me ? plan.byMember[me.id] || [] : [];

  render(
    h(
      'div',
      {},
      renderTopbar(clan, members),
      h(
        'div',
        { class: 'shell' },
        renderWhoAmI(me, members),
        h(
          'div',
          { class: 'tabs', role: 'tablist' },
          tabButton('cards', 'My cards', me ? `${me.summary.owned}/60` : null),
          tabButton('board', 'Clan board', String(members.length)),
          tabButton('trades', 'Trades', String(me ? myTrades.length : plan.stats.trades)),
        ),
        state.tab === 'cards' ? renderMyCards(me) : null,
        state.tab === 'board' ? renderBoard(members) : null,
        state.tab === 'trades' ? renderTrades(me, plan, members) : null,
        h('p', {
          class: 'footer-note',
          text: `Updated ${new Date(state.data.generatedAt).toLocaleTimeString()} · card art belongs to Supercell`,
        }),
      ),
    ),
  );
}

function tabButton(id, label, badge) {
  return h(
    'button',
    {
      role: 'tab',
      'aria-selected': String(state.tab === id),
      onclick: () => {
        state.tab = id;
        renderClan();
      },
    },
    label,
    badge ? h('span', { class: 'pill', text: badge }) : null,
  );
}

function renderTopbar(clan, members) {
  const spares = members.reduce((sum, m) => sum + m.summary.spares, 0);
  return h(
    'div',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-inner' },
      h(
        'a',
        {
          class: 'brandmark',
          href: '/',
          onclick: (e) => {
            e.preventDefault();
            navigate('/');
          },
        },
        h('span', { class: 'seal', text: '⇄' }),
      ),
      h(
        'div',
        { class: 'clan-title' },
        h('h1', { text: clan.name }),
        h('p', {
          text: `${members.length} member${members.length === 1 ? '' : 's'} · ${spares} spare card${spares === 1 ? '' : 's'} in the pool`,
        }),
      ),
      h(
        'button',
        {
          class: 'btn btn-small btn-primary',
          onclick: async () => {
            const url = `${location.origin}/c/${state.clanId}`;
            try {
              if (navigator.share) await navigator.share({ title: clan.name, url });
              else {
                await navigator.clipboard.writeText(url);
                toast('Link copied — paste it in your clan chat');
              }
            } catch {
              /* the user dismissed the share sheet */
            }
          },
        },
        'Share',
      ),
    ),
  );
}

function renderWhoAmI(me, members) {
  if (me) {
    return h(
      'div',
      { class: 'whoami' },
      h('div', { class: 'avatar', text: me.name.slice(0, 1).toUpperCase() }),
      h(
        'div',
        { class: 'who' },
        h('b', { text: me.name }),
        h('span', {
          text: `${me.summary.owned} of 60 cards · ${me.summary.spares} spare · ${me.summary.missing} missing`,
        }),
      ),
      h(
        'div',
        { style: 'display:flex;gap:8px;flex-wrap:wrap' },
        h(
          'button',
          {
            class: 'btn btn-small',
            onclick: () => {
              store.setIdentity(state.clanId, null);
              state.me = null;
              state.myCounts = {};
              renderClan();
            },
          },
          'Not you?',
        ),
        h(
          'button',
          {
            class: 'btn btn-small btn-danger',
            onclick: async () => {
              if (!confirm(`Remove ${me.name} and all their cards from this board?`)) return;
              try {
                await api(`/clans/${state.clanId}/members/${me.id}`, { method: 'DELETE' });
                store.setIdentity(state.clanId, null);
                state.me = null;
                state.myCounts = {};
                await loadClan({ quiet: true });
                toast('Removed from the board');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          'Leave',
        ),
      ),
    );
  }

  const form = h(
    'form',
    {
      class: 'join-form',
      onsubmit: async (event) => {
        event.preventDefault();
        const input = form.querySelector('input');
        const name = input.value.trim();
        if (!name) return input.focus();
        await join(name, false);
      },
    },
    h('input', {
      class: 'input',
      placeholder: 'Your name in the clan',
      maxlength: '40',
      autocomplete: 'off',
      'aria-label': 'Your name in the clan',
    }),
    h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add me'),
  );

  const picker = members.length
    ? h(
        'div',
        { style: 'width:100%' },
        h('p', {
          class: 'muted',
          style: 'font-size:.82rem;margin:10px 0 6px',
          text: 'Already on the list? Tap your name:',
        }),
        h(
          'div',
          { class: 'chip-row' },
          ...members.map((m) =>
            h(
              'button',
              {
                class: 'chip',
                style: 'padding:6px 12px;cursor:pointer',
                onclick: () => claim(m),
              },
              m.name,
            ),
          ),
        ),
      )
    : null;

  return h(
    'div',
    { class: 'whoami' },
    h(
      'div',
      { class: 'who', style: 'min-width:100%' },
      h('b', { text: 'Who are you?' }),
      h('span', { text: 'Pick your name so the plan can tell you what to trade.' }),
    ),
    form,
    picker,
  );
}

function claim(member) {
  store.setIdentity(state.clanId, { id: member.id, name: member.name });
  state.me = member.id;
  state.myCounts = { ...(member.counts || {}) };
  state.tab = 'cards';
  renderClan();
  toast(`Welcome back, ${member.name}`);
}

async function join(name, claimExisting) {
  try {
    const { member } = await api(`/clans/${state.clanId}/members`, {
      method: 'POST',
      body: { name, claimExisting },
    });
    store.setIdentity(state.clanId, { id: member.id, name: member.name });
    state.me = member.id;
    state.myCounts = { ...(member.counts || {}) };
    state.tab = 'cards';
    await loadClan({ quiet: true });
    toast(`You're on the board, ${member.name}`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// --- tab: my cards ----------------------------------------------------------

function renderMyCards(me) {
  if (!me) {
    return h(
      'div',
      { class: 'empty' },
      h('b', { text: 'Add yourself first' }),
      h('p', { text: 'Pick your name above, then tap in the cards you own.' }),
    );
  }

  const groups = new Map();
  for (const card of state.cards) {
    if (!groups.has(card.category)) groups.set(card.category, []);
    groups.get(card.category).push(card);
  }

  return h(
    'section',
    {},
    h(
      'div',
      { class: 'section-head' },
      h('h2', { text: 'Your cards' }),
      h('p', { class: 'hint', text: 'Tap + for every copy you hold. 0 means you are missing it.' }),
    ),
    h(
      'div',
      { class: 'legend' },
      h('span', {}, h('i', { class: 'l-missing' }), 'missing'),
      h('span', {}, h('i', { class: 'l-owned' }), 'owned'),
      h('span', {}, h('i', { class: 'l-spare' }), 'spare to trade'),
    ),
    ...[...groups.entries()].map(([category, cards]) =>
      h(
        'div',
        {},
        h('h3', { class: 'group-title', text: state.categories[category] || 'Cards' }),
        h('div', { class: 'card-grid' }, ...cards.map(cardTile)),
      ),
    ),
    h(
      'div',
      { style: 'margin-top:26px;display:flex;gap:8px;flex-wrap:wrap' },
      h(
        'button',
        {
          class: 'btn btn-small',
          onclick: async () => {
            if (!confirm('Set every card back to 0?')) return;
            state.myCounts = {};
            renderClan();
            try {
              await api(`/clans/${state.clanId}/members/${state.me}/cards`, {
                method: 'PUT',
                body: { counts: {} },
              });
              scheduleRefresh(200);
              toast('Collection cleared');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        'Clear my collection',
      ),
    ),
  );
}

function cardTile(card) {
  const count = state.myCounts[card.id] || 0;
  const status = count === 0 ? 'is-missing' : count === 1 ? 'is-owned' : 'is-spare';

  const tile = h(
    'div',
    { class: `card-tile ${status}`, dataset: { card: String(card.id) } },
    count > 1 ? h('span', { class: 'flag', text: `${count - 1} spare` }) : null,
    h(
      'button',
      {
        style: 'background:none;border:0;padding:0;cursor:pointer',
        'aria-label': `Add one ${card.name}`,
        onclick: () => setCount(card.id, count + 1),
      },
      cardIcon(card.id, 54),
    ),
    h('span', { class: 'name', text: card.name }),
    h(
      'div',
      { class: 'stepper' },
      h(
        'button',
        {
          class: 'minus',
          'aria-label': `Remove one ${card.name}`,
          disabled: count === 0,
          onclick: () => setCount(card.id, count - 1),
        },
        '−',
      ),
      h('span', { class: 'count', text: String(count) }),
      h(
        'button',
        {
          class: 'plus',
          'aria-label': `Add one ${card.name}`,
          onclick: () => setCount(card.id, count + 1),
        },
        '+',
      ),
    ),
  );
  return tile;
}

/** Optimistic: the tile updates instantly, the save follows behind it. */
function setCount(cardId, next) {
  const count = Math.max(0, Math.min(99, next));
  if (count === 0) delete state.myCounts[cardId];
  else state.myCounts[cardId] = count;

  patchTile(cardId);

  clearTimeout(state.pending.get(cardId));
  state.pending.set(
    cardId,
    setTimeout(async () => {
      try {
        await api(`/clans/${state.clanId}/members/${state.me}/cards`, {
          method: 'PATCH',
          body: { cardId, count },
        });
        state.pending.delete(cardId);
        if (state.pending.size === 0) scheduleRefresh(400);
      } catch (err) {
        state.pending.delete(cardId);
        toast(err.message, 'error');
        loadClan({ quiet: true });
      }
    }, 350),
  );
}

/** Swaps a single tile in place so the whole grid doesn't flicker. */
function patchTile(cardId) {
  const old = app.querySelector(`.card-tile[data-card="${cardId}"]`);
  if (!old) return renderClan();
  const card = state.byId.get(cardId);
  const fresh = cardTile(card);
  fresh.classList.add('bump');
  old.replaceWith(fresh);
}

// --- tab: clan board --------------------------------------------------------

function renderBoard(members) {
  if (!members.length) {
    return h(
      'div',
      { class: 'empty' },
      h('b', { text: 'Nobody has joined yet' }),
      h('p', { text: 'Share the link with your clan — every member adds their own column.' }),
    );
  }

  const head = h(
    'tr',
    {},
    h('th', { class: 'corner', text: 'Card' }),
    ...members.map((m) =>
      h(
        'th',
        { class: m.id === state.me ? 'me' : null, title: m.name },
        h('div', { class: 'vname', text: m.name }),
      ),
    ),
  );

  const rows = state.cards.map((card) => {
    let spares = 0;
    let missing = 0;
    const cells = members.map((m) => {
      const count = (m.id === state.me ? state.myCounts : m.counts)[card.id] || 0;
      if (count > 1) spares += count - 1;
      if (count === 0) missing++;
      const cls = [count > 1 ? 'spare' : count === 1 ? 'owned' : '', m.id === state.me ? 'me' : '']
        .filter(Boolean)
        .join(' ');
      return h('td', { class: cls || null, text: count === 0 ? '·' : String(count) });
    });

    return h(
      'tr',
      {},
      h(
        'th',
        {},
        h(
          'div',
          { class: 'row-card' },
          cardIcon(card.id, 30),
          h(
            'div',
            { style: 'min-width:0' },
            h('div', { class: 'row-name', text: card.name }),
            h(
              'div',
              { class: 'row-meta' },
              h('span', { class: 'spare', text: `${spares} spare` }),
              ' · ',
              h('span', { class: 'need', text: `${missing} need` }),
            ),
          ),
        ),
      ),
      ...cells,
    );
  });

  return h(
    'section',
    {},
    h(
      'div',
      { class: 'section-head' },
      h('h2', { text: 'Clan board' }),
      h('p', { class: 'hint', text: 'Gold cells are spares. Scroll sideways for more members.' }),
    ),
    h(
      'div',
      { class: 'board-wrap' },
      h('table', { class: 'board' }, h('thead', {}, head), h('tbody', {}, ...rows)),
    ),
  );
}

// --- tab: trades ------------------------------------------------------------

function renderTrades(me, plan, members) {
  const done = store.doneTrades(state.clanId);
  const showMine = state.scope === 'mine' && me;

  const stats = h(
    'div',
    { class: 'plan-stats' },
    stat(plan.stats.trades, 'trades found'),
    stat(plan.stats.cardsMoved, 'cards move'),
    stat(plan.stats.membersTrading, 'members involved'),
    stat(
      plan.stats.optimal ? 'Best' : `${plan.stats.upperBound}`,
      plan.stats.optimal ? 'possible plan' : 'theoretical max',
    ),
  );

  const filters = me
    ? h(
        'div',
        { class: 'filter-row' },
        h(
          'button',
          {
            class: `btn btn-small${showMine ? ' btn-primary' : ''}`,
            onclick: () => {
              state.scope = 'mine';
              renderClan();
            },
          },
          'My trades',
        ),
        h(
          'button',
          {
            class: `btn btn-small${showMine ? '' : ' btn-primary'}`,
            onclick: () => {
              state.scope = 'all';
              renderClan();
            },
          },
          'Everyone',
        ),
      )
    : null;

  let body;
  if (showMine) {
    const mine = plan.byMember[me.id] || [];
    body = mine.length
      ? renderMyTradeGroups(mine, done)
      : h(
          'div',
          { class: 'empty' },
          h('b', { text: 'No trade for you yet' }),
          h('p', {
            text: plan.stats.trades
              ? 'Your spares are not what the others are missing right now. Add more cards, or wait for the next member to join.'
              : 'As soon as two people have matching spares, the plan shows up here.',
          }),
        );
  } else {
    body = plan.trades.length
      ? h(
          'div',
          { class: 'ticket-list' },
          ...plan.trades.map((t) =>
            ticket({
              key: `${t.a}-${t.b}-${t.aGives}-${t.bGives}`,
              leftName: t.aName,
              rightName: t.bName,
              leftCard: t.aGives,
              rightCard: t.bGives,
              leftRole: 'gives',
              rightRole: 'gives',
              done,
            }),
          ),
        )
      : h(
          'div',
          { class: 'empty' },
          h('b', { text: 'Nothing to trade yet' }),
          h('p', { text: 'Once members enter their cards, matching swaps appear here automatically.' }),
        );
  }

  const leftovers = me && plan.leftovers[me.id] ? plan.leftovers[me.id] : null;

  return h(
    'section',
    {},
    h(
      'div',
      { class: 'section-head' },
      h('h2', { text: 'Trade plan' }),
      h('p', {
        class: 'hint',
        text: 'Cards can only be swapped inside the same group, so every swap here is Elixir for Elixir, Super for Super, and so on.',
      }),
    ),
    stats,
    filters,
    body,
    leftovers ? renderLeftovers(leftovers, members) : null,
  );
}

function stat(value, label) {
  return h('div', { class: 'stat' }, h('b', { text: String(value) }), h('span', { text: label }));
}

function renderMyTradeGroups(mine, done) {
  const byPartner = new Map();
  for (const t of mine) {
    if (!byPartner.has(t.partner)) byPartner.set(t.partner, []);
    byPartner.get(t.partner).push(t);
  }

  return h(
    'div',
    {},
    ...[...byPartner.entries()].map(([partnerId, trades]) =>
      h(
        'div',
        { class: 'partner-group' },
        h(
          'h3',
          {},
          `Trade with ${trades[0].partnerName}`,
          h('span', {
            class: 'count-chip',
            text: `${trades.length} swap${trades.length === 1 ? '' : 's'}`,
          }),
        ),
        h(
          'div',
          { class: 'ticket-list' },
          ...trades.map((t) =>
            ticket({
              key: `${state.me}-${partnerId}-${t.give}-${t.get}`,
              leftName: 'You give',
              rightName: 'You get',
              leftCard: t.give,
              rightCard: t.get,
              headline: t.partnerName,
              done,
            }),
          ),
        ),
      ),
    ),
  );
}

function ticket({ key, leftName, rightName, leftCard, rightCard, headline, done }) {
  const isDone = done.has(key);
  const node = h(
    'article',
    { class: `ticket${isDone ? ' done' : ''}` },
    h(
      'div',
      { class: 'ticket-head' },
      h('span', { text: headline ? 'Swap' : leftName }),
      h('span', { class: 'with', text: headline || rightName }),
    ),
    h(
      'div',
      { class: 'ticket-side give' },
      cardIcon(leftCard, 66),
      h('span', { class: 'card-name', text: cardName(leftCard) }),
      h('span', { class: 'role', text: headline ? 'you hand over' : `${leftName} gives` }),
    ),
    h('div', { class: 'ticket-divider' }, h('div', { class: 'seal', text: '⇄' })),
    h(
      'div',
      { class: 'ticket-side get' },
      cardIcon(rightCard, 66),
      h('span', { class: 'card-name', text: cardName(rightCard) }),
      h('span', { class: 'role', text: headline ? 'you receive' : `${rightName} gives` }),
    ),
    h(
      'div',
      { class: 'ticket-actions' },
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: isDone,
          onchange: (event) => {
            const set = store.doneTrades(state.clanId);
            if (event.target.checked) set.add(key);
            else set.delete(key);
            store.setDone(state.clanId, set);
            node.classList.toggle('done', event.target.checked);
          },
        }),
        'Done',
      ),
    ),
  );
  return node;
}

function renderLeftovers(leftovers, members) {
  const { unmatchedSpares, stillMissing } = leftovers;
  if (!unmatchedSpares.length && !stillMissing.length) return null;

  const chips = (ids) =>
    h(
      'div',
      { class: 'chip-row' },
      ...ids.map((id) => h('span', { class: 'chip' }, cardIcon(id, 22), cardName(id))),
    );

  return h(
    'section',
    { style: 'margin-top:30px' },
    h('h3', { class: 'group-title', text: 'After these trades' }),
    unmatchedSpares.length
      ? h(
          'div',
          { class: 'panel', style: 'margin-bottom:12px' },
          h('p', { class: 'eyebrow', text: 'Spares nobody in the clan needs' }),
          h('p', {
            class: 'muted',
            style: 'font-size:.85rem;margin:4px 0 10px',
            text: 'Everyone missing these either gets one from someone else, or has nothing from the same group to trade back.',
          }),
          chips(unmatchedSpares),
        )
      : null,
    stillMissing.length
      ? h(
          'div',
          { class: 'panel' },
          h('p', { class: 'eyebrow', text: 'Still missing afterwards' }),
          h('p', {
            class: 'muted',
            style: 'font-size:.85rem;margin:4px 0 10px',
            text: `Nobody among the ${members.length} members can complete a swap for these — either no one holds a spare, or they have nothing you can give back from the same group.`,
          }),
          chips(stillMissing),
        )
      : null,
  );
}

// --- boot -------------------------------------------------------------------

function render(node) {
  app.replaceChildren(node);
}

async function boot() {
  const data = await fetch('/data/cards.json').then((r) => r.json());
  state.cards = data.cards;
  state.categories = data.categories;
  state.byId = new Map(data.cards.map((c) => [c.id, c]));
  await route();
}

boot().catch((err) => {
  app.replaceChildren(
    h(
      'div',
      { class: 'shell' },
      h(
        'div',
        { class: 'empty', style: 'margin-top:60px' },
        h('b', { text: 'ClashSwap could not start' }),
        h('p', { text: err.message }),
      ),
    ),
  );
});
