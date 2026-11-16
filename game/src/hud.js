// The HUD draws from one snapshot of the round, so the panel never shows a number the simulation
// has already moved past. main.js builds the snapshot; this file only reads the DOM.
const $ = (id) => document.getElementById(id);

export function createHud() {
  const el = {
    overlay: $('overlay'),
    title: $('overlay-title'),
    copy: $('overlay-copy'),
    play: $('play'),
    keys: $('overlay-keys'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    ammoName: $('ammo-name'),
    scoreAtk: $('score-atk'),
    scoreDef: $('score-def'),
    money: $('money'),
    timer: $('timer'),
    roundLabel: $('round-label'),
    aliveAtk: $('alive-atk'),
    aliveDef: $('alive-def'),
    hitmarker: $('hitmarker'),
    killfeed: $('killfeed'),
    bombBar: $('bomb-bar'),
    bombBarFill: $('bomb-bar-fill'),
    bombLabel: $('bomb-label'),
    damageFlash: $('damage-flash'),
    hurt: $('hurt-vignette'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerCopy: $('banner-copy'),
    buy: $('buy'),
    buyMoney: $('buy-money'),
    buyItems: $('buy-items'),
    buyHint: $('buy-hint'),
    reloadBar: $('reload-bar'),
    reloadFill: $('reload-fill'),
    prompt: $('prompt'),
  };

  const cache = {};
  let hitTimer = 0;
  let bannerTimer = 0;

  function setText(node, value) {
    if (!node) return;
    const key = node.id || node.className;
    if (cache[key] === value) return;
    cache[key] = value;
    node.textContent = value;
  }

  function fmtTime(seconds) {
    const whole = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // ---- kill feed --------------------------------------------------------------------------
  // Newest line on top, four kept, each fading out on its own so the feed never needs clearing.
  function feed(text, tone = 'neutral') {
    if (!el.killfeed) return;
    const line = document.createElement('div');
    line.className = `feed-line feed-${tone}`;
    line.textContent = text;
    el.killfeed.prepend(line);
    while (el.killfeed.children.length > 4) el.killfeed.lastChild.remove();
    setTimeout(() => {
      line.classList.add('feed-out');
      setTimeout(() => line.remove(), 260);
    }, 4200);
  }

  // ---- buy menu ---------------------------------------------------------------------------
  // The menu is rebuilt only when the money or the phase changes, so a hover does not cost a
  // render. Each entry is a button main.js can wire to a purchase.
  let lastBuySignature = '';
  function renderBuy(items, money, open, hint) {
    if (!el.buy) return;
    el.buy.hidden = !open;
    if (!open) return;
    setText(el.buyMoney, `$${money}`);
    setText(el.buyHint, hint || 'Press B to close · buy before the whistle');
    const signature = `${items.map((item) => `${item.id}:${item.price}:${item.affordable}`).join('|')}#${money}`;
    if (signature === lastBuySignature) return;
    lastBuySignature = signature;
    el.buyItems.replaceChildren();
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'buy-item';
      button.dataset.buy = item.id;
      button.disabled = !item.affordable;
      button.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-name">${item.name}</span><span class="buy-price">$${item.price}</span>`;
      el.buyItems.appendChild(button);
    }
  }

  return {
    feed,
    renderBuy,
    // One call per frame with everything the panel needs.
    update(view) {
      setText(el.money, `$${view.money}`);
      setText(el.scoreAtk, String(view.scoreAtk));
      setText(el.scoreDef, String(view.scoreDef));
      setText(el.timer, fmtTime(view.time));
      setText(el.roundLabel, view.roundLabel);
      setText(el.aliveAtk, String(view.aliveAtk));
      setText(el.aliveDef, String(view.aliveDef));
      setText(el.ammoMag, String(view.ammo.mag));
      setText(el.ammoReserve, `/ ${view.ammo.reserve}`);
      setText(el.ammoName, view.ammo.name);
      if (el.ammoMag) el.ammoMag.parentElement.classList.toggle('empty', view.ammo.mag === 0);
      if (el.timer) el.timer.classList.toggle('urgent', view.time <= 10);

      // Hit marker: a kill flashes larger and holds longer, so a trade reads at a glance.
      if (el.hitmarker) {
        if (view.hitMarker) {
          el.hitmarker.classList.add('on');
          el.hitmarker.classList.toggle('kill', Boolean(view.hitMarker.kill));
          clearTimeout(hitTimer);
          hitTimer = setTimeout(() => el.hitmarker.classList.remove('on'), view.hitMarker.kill ? 220 : 90);
        }
      }

      // Damage and the red edge: both are pure CSS opacity, so no layout work per frame.
      if (el.damageFlash) el.damageFlash.style.opacity = String(Math.max(0, view.damageFlash));
      if (el.hurt) el.hurt.style.opacity = String(Math.max(0, Math.min(0.85, (100 - view.health) / 120)));

      // Reload ring.
      if (el.reloadBar) {
        el.reloadBar.hidden = !view.ammo.reloading;
        if (view.ammo.reloading && el.reloadFill) {
          el.reloadFill.style.transform = `scaleX(${Math.max(0, Math.min(1, view.ammo.reloadProgress))})`;
        }
      }

      // Bomb progress: a plant and a defuse share one bar because they never run at once.
      if (el.bombBar) {
        const show = view.bomb && (view.bomb.plant > 0 || view.bomb.defuse > 0);
        el.bombBar.hidden = !show;
        if (show) {
          const pct = view.bomb.defuse > 0 ? view.bomb.defuse : view.bomb.plant;
          el.bombBarFill.style.transform = `scaleX(${Math.max(0, Math.min(1, pct))})`;
          el.bombBar.classList.toggle('defuse', view.bomb.defuse > 0);
          setText(el.bombLabel, view.bomb.defuse > 0 ? 'DEFUSING' : 'PLANTING');
        }
      }

      if (el.prompt) {
        setText(el.prompt, view.prompt || '');
        el.prompt.hidden = !view.prompt;
      }
    },
    banner(title, copy, holdMs = 2600) {
      if (!el.banner) return;
      setText(el.bannerTitle, title);
      setText(el.bannerCopy, copy);
      el.banner.hidden = false;
      el.banner.classList.add('on');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => {
        el.banner.classList.remove('on');
        el.banner.hidden = true;
      }, holdMs);
    },
    showOverlay(mode, extra) {
      if (!el.overlay) return;
      const COPY = {
        start: {
          title: 'Freight Yard · Defend',
          copy: 'Hold the site in the middle lane through five rounds. The crew attacking is live from the first whistle. Buy before the round starts; Kevlar and a rifle are the difference.',
          action: 'Click to deploy',
        },
        paused: {
          title: 'Paused',
          copy: 'The yard is waiting. Click to go back in.',
          action: 'Click to resume',
        },
        over: {
          title: extra && extra.won ? 'Site held' : 'Yard lost',
          copy: `Match over · ${extra ? `${extra.scoreDef}–${extra.scoreAtk}` : ''}. ${extra && extra.won ? 'The crew held every push it needed.' : 'The attackers took the yard. Reset and go again.'}`,
          action: 'Play again',
        },
      };
      const text = COPY[mode] || COPY.start;
      setText(el.title, text.title);
      setText(el.copy, text.copy);
      setText(el.play, text.action);
      el.overlay.hidden = false;
    },
    hideOverlay() {
      if (el.overlay) el.overlay.hidden = true;
    },
    onPlay(handler) {
      if (el.play) el.play.addEventListener('click', handler);
    },
    onBuy(handler) {
      if (!el.buyItems) return;
      el.buyItems.addEventListener('click', (event) => {
        const button = event.target.closest('[data-buy]');
        if (!button || button.disabled) return;
        handler(button.dataset.buy);
      });
    },
  };
}
